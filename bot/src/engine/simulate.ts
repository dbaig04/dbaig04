// Mandatory pre-send simulation. Requests post-state of the user's wSOL and RISE
// token accounts, computes simulated profit = Δ wSOL − fee, and rejects on any
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
  commitment?: Commitment;
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
  /** Δ wSOL − fee */
  simulatedProfit?: bigint;
  /** Quote-implied profit at the same fee. */
  expectedProfit?: bigint;
  logs?: string[];
}

const abs = (x: bigint) => (x < 0n ? -x : x);

export async function simulateArb(conn: SimConnection, tx: VersionedTransaction, plan: Plan, p: SimParams): Promise<SimResult> {
  let res;
  try {
    res = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: p.commitment ?? "processed",
      accounts: { encoding: "base64", addresses: [p.wsolAta.toBase58(), p.riseAta.toBase58()] },
    });
  } catch (e) {
    return { ok: false, reason: `simulate rpc error: ${(e as Error).message}` };
  }
  const v = res.value;
  const base: SimResult = { ok: false, slot: res.context.slot, err: v.err ?? undefined, unitsConsumed: v.unitsConsumed ?? undefined, logs: v.logs ?? undefined };
  if (v.err) return { ...base, reason: `sim error: ${JSON.stringify(v.err)}` };
  if (!v.unitsConsumed) return { ...base, reason: "sim returned no unitsConsumed" };
  const accs = v.accounts;
  if (!accs || accs.length !== 2 || !accs[0] || !accs[1]) return { ...base, reason: "sim did not return token account post-state" };
  const dec = (a: NonNullable<(typeof accs)[number]>) => decodeTokenAmount(Buffer.from(a.data[0], "base64"));
  const wsolPost = dec(accs[0]);
  const risePost = dec(accs[1]);
  const wsolDelta = wsolPost - p.wsolPre;
  const riseDelta = risePost - p.risePre;
  const { cuLimit, fee } = p.feeForUnits(v.unitsConsumed);
  const simulatedProfit = wsolDelta - fee;
  const expectedProfit = plan.lamportsOut - plan.lamportsIn - fee;
  const r: SimResult = { ...base, cuLimit, fee, wsolPost, risePost, wsolDelta, riseDelta, simulatedProfit, expectedProfit };
  if (riseDelta < 0n) return { ...r, reason: `sim loses RISE: ${riseDelta}` };
  if (simulatedProfit < p.profitFloorLamports) return { ...r, reason: `sim profit ${simulatedProfit} < floor ${p.profitFloorLamports}` };
  const tol = (() => { const t = (abs(expectedProfit) * p.toleranceBps) / 10_000n; return t > p.toleranceLamports ? t : p.toleranceLamports; })();
  // Worst-case lamportsIn may exceed the quoted spend by the slippage allowance (buyThenRedeem);
  // a sim that spends less is legitimately better than "expected" by up to that much.
  const slipAllowance = plan.direction === "buyThenRedeem" ? plan.lamportsIn - plan.leg1Quote : 0n;
  if (simulatedProfit < expectedProfit - tol || simulatedProfit > expectedProfit + tol + slipAllowance)
    return { ...r, reason: `sim profit ${simulatedProfit} deviates from expected ${expectedProfit} beyond tolerance ${tol}` };
  return { ...r, ok: true };
}
