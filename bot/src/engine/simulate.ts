// Mandatory pre-send simulation. Requests post-state of the user's wSOL and RISE
// token accounts, computes simulated profit = Δ wSOL − fee − tip, and rejects on any
// sim error, profit below floor, RISE loss, or deviation from the quote.
import type { Commitment, Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { decodeTokenAmount } from "./state.js";
import type { Plan } from "./optimizer.js";

export type SimConnection = Pick<Connection, "simulateTransaction">;

export interface SimParams {
  wsolAta: PublicKey;
  riseAta: PublicKey;
  /** Pre-trade balances (from the same state snapshot the plan was made on). */
  wsolPre: bigint;
  risePre: bigint;
  profitFloorLamports: bigint;
  toleranceLamports: bigint;
  toleranceBps: bigint;
  /** Fee the final tx will pay, given the CU limit derived from the sim. */
  feeForUnits: (unitsConsumed: number) => { cuLimit: number; fee: bigint };
  /** In-tx tip (native SOL transfer, Jito). Not visible in Δ wSOL, so it is subtracted explicitly. */
  tipLamports?: bigint;
  commitment?: Commitment;
  /**
   * Refuse to simulate on RPC state older than this slot (the slot our quote's snapshot came from).
   * Without it a lagging RPC simulates on the previous slot's state, which may not yet contain the
   * trade that opened the gap. The RPC answers "minimum context slot not reached" until it catches
   * up; we retry every `slotWaitPollMs` for at most `slotWaitMs`, then reject as "rpc behind".
   */
  minContextSlot?: number;
  slotWaitMs?: number;
  slotWaitPollMs?: number;
}

export interface SimResult {
  ok: boolean;
  reason?: string;
  slot?: number;
  err?: unknown;
  unitsConsumed?: number;
  cuLimit?: number;
  fee?: bigint;
  wsolPost?: bigint;
  risePost?: bigint;
  wsolDelta?: bigint;
  riseDelta?: bigint;
  /** Δ wSOL − fee − tip */
  simulatedProfit?: bigint;
  /** Quote-implied profit at the same fee. */
  expectedProfit?: bigint;
  logs?: string[];
  /** Time spent waiting for the RPC to reach minContextSlot (ms) and the number of retries. */
  rpcBehindMs?: number;
  rpcBehindRetries?: number;
  /** Retries after other RPC errors while waiting (and the last such error, credential-free). */
  rpcErrorRetries?: number;
  rpcError?: string;
}

/** Message + JSON-RPC code of an RPC error, with any URL stripped (never leak an API key). */
export function describeRpcError(e: unknown): string {
  const err = e as { message?: string; code?: number | string };
  const code = err?.code !== undefined ? ` [code ${err.code}]` : "";
  return `${String(err?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200)}${code}`;
}

const isBehind = (e: unknown) => /minimum context slot|-32016/i.test(String((e as Error)?.message ?? e));

const abs = (x: bigint) => (x < 0n ? -x : x);

/** What the sim needs from a plan (RISE Plan or generic pair plan: lamportsIn = net quoted spend). */
export type SimPlan = Pick<Plan, "lamportsIn" | "lamportsOut"> & { direction?: string; leg1Quote?: bigint };

export async function simulateArb(conn: SimConnection, tx: VersionedTransaction, plan: SimPlan, p: SimParams): Promise<SimResult> {
  let res;
  const t0 = performance.now();
  let retries = 0, otherRetries = 0;
  let lastErr: string | undefined;
  for (;;) {
    try {
      res = await conn.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: p.commitment ?? "processed",
        ...(p.minContextSlot !== undefined ? { minContextSlot: p.minContextSlot } : {}),
        accounts: { encoding: "base64", addresses: [p.wsolAta.toBase58(), p.riseAta.toBase58()] },
      });
      // some RPCs ignore minContextSlot: enforce it on the returned context as well
      if (p.minContextSlot !== undefined && res.context.slot < p.minContextSlot) throw new Error(`minimum context slot not reached (sim slot ${res.context.slot} < ${p.minContextSlot})`);
      break;
    } catch (e) {
      const waited = performance.now() - t0;
      const behindErr = isBehind(e);
      if (!behindErr) lastErr = describeRpcError(e);
      // With minContextSlot set, retry ANY RPC error within the wait window: simulation is read-only,
      // and some providers answer an unreached minContextSlot with a generic error instead of -32016.
      if (p.minContextSlot !== undefined && waited < (p.slotWaitMs ?? 400)) {
        if (behindErr) retries++; else otherRetries++;
        await new Promise((r) => setTimeout(r, p.slotWaitPollMs ?? 20));
        continue;
      }
      const tried = { rpcBehindMs: Math.round(waited), rpcBehindRetries: retries, rpcErrorRetries: otherRetries, ...(lastErr ? { rpcError: lastErr } : {}) };
      if (p.minContextSlot !== undefined && (behindErr || !lastErr)) return { ok: false, reason: `rpc behind snapshot slot ${p.minContextSlot} after ${Math.round(waited)} ms`, ...tried };
      return { ok: false, reason: `simulate rpc error: ${lastErr ?? describeRpcError(e)}${p.minContextSlot !== undefined ? ` (after ${retries + otherRetries} retries, ${Math.round(waited)} ms)` : ""}`, ...(p.minContextSlot !== undefined ? tried : {}) };
    }
  }
  const behind = retries || otherRetries ? { rpcBehindMs: Math.round(performance.now() - t0), rpcBehindRetries: retries, rpcErrorRetries: otherRetries, ...(lastErr ? { rpcError: lastErr } : {}) } : {};
  const v = res.value;
  const base: SimResult = { ok: false, slot: res.context.slot, err: v.err ?? undefined, unitsConsumed: v.unitsConsumed ?? undefined, logs: v.logs ?? undefined, ...behind };
  if (v.err) return { ...base, reason: `sim error: ${JSON.stringify(v.err)}` };
  if (!v.unitsConsumed) return { ...base, reason: "sim returned no unitsConsumed" };
  const accs = v.accounts;
  if (!accs || accs.length !== 2 || !accs[0] || !accs[1]) return { ...base, reason: "sim did not return token account post-state" };
  const dec = (a: NonNullable<(typeof accs)[number]>) => decodeTokenAmount(Buffer.from(a.data[0], "base64"));
  return evaluateSimOutcome(base, v.unitsConsumed, dec(accs[0]), dec(accs[1]), plan, p);
}

/**
 * Checks shared by every simulator (RPC simulateTransaction here, LiteSVM in local-sim.ts) once the
 * tx executed without error: Δ = post − pre of the user's wSOL / token accounts, simulated profit =
 * Δ wSOL − fee − tip, then token loss / floor / deviation-from-quote checks.
 */
export function evaluateSimOutcome(base: SimResult, unitsConsumed: number, wsolPost: bigint, risePost: bigint, plan: SimPlan, p: Pick<SimParams, "wsolPre" | "risePre" | "feeForUnits" | "tipLamports" | "profitFloorLamports" | "toleranceLamports" | "toleranceBps">): SimResult {
  const wsolDelta = wsolPost - p.wsolPre;
  const riseDelta = risePost - p.risePre;
  const { cuLimit, fee } = p.feeForUnits(unitsConsumed);
  const tip = p.tipLamports ?? 0n;
  const simulatedProfit = wsolDelta - fee - tip;
  const expectedProfit = plan.lamportsOut - plan.lamportsIn - fee - tip;
  const r: SimResult = { ...base, cuLimit, fee, wsolPost, risePost, wsolDelta, riseDelta, simulatedProfit, expectedProfit };
  if (riseDelta < 0n) return { ...r, reason: `sim loses RISE: ${riseDelta}` };
  if (simulatedProfit < p.profitFloorLamports) return { ...r, reason: `sim profit ${simulatedProfit} < floor ${p.profitFloorLamports}` };
  const tol = (() => { const t = (abs(expectedProfit) * p.toleranceBps) / 10_000n; return t > p.toleranceLamports ? t : p.toleranceLamports; })();
  // Worst-case lamportsIn may exceed the quoted spend by the slippage allowance (buyThenRedeem);
  // a sim that spends less is legitimately better than "expected" by up to that much.
  const slipAllowance = plan.direction === "buyThenRedeem" && plan.leg1Quote !== undefined ? plan.lamportsIn - plan.leg1Quote : 0n;
  if (simulatedProfit < expectedProfit - tol || simulatedProfit > expectedProfit + tol + slipAllowance)
    return { ...r, reason: `sim profit ${simulatedProfit} deviates from expected ${expectedProfit} beyond tolerance ${tol}` };
  return { ...r, ok: true };
}
