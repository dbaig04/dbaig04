// Append-only JSONL ledger of every opportunity, simulation, submission and
// outcome. Realized PnL is computed from the landed transaction itself
// (getTransaction meta: fee, pre/post token + native balances), never from quotes.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Connection } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, RISE_PROGRAM_ID, type Direction } from "../types.js";

export type LedgerEventType =
  | "start" | "stop" | "opportunity" | "simulation" | "submission" | "outcome" | "error" | "latency" | "hold"
  /** risk halt (every halt reason) */
  | "halt"
  /** non-halting risk rejection of a plan (stale state, spending limits, duplicates) */
  | "risk"
  /** startup on-chain vs ledger balance reconciliation */
  | "reconcile"
  /** on-chain wSOL / RISE balance snapshot (baseline for the next reconcile) */
  | "balances";

export interface LedgerEvent {
  ts: string;
  type: LedgerEventType;
  [k: string]: unknown;
}

/** JSON with bigint -> decimal string. */
export function toJson(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class Ledger {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  append(type: LedgerEventType, data: Record<string, unknown>): LedgerEvent {
    const ev: LedgerEvent = { ts: new Date().toISOString(), type, ...data };
    appendFileSync(this.path, toJson(ev) + "\n");
    return ev;
  }
  static read(path: string): LedgerEvent[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => {
        try { return JSON.parse(l) as LedgerEvent; } catch { throw new Error(`${path}:${i + 1}: bad JSON line`); }
      });
  }
}

// ---------- realized PnL from raw getTransaction (JSON encoding) ----------

interface RawTokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface RawIx { programIdIndex: number; accounts: number[]; data: string }
export interface RawTx {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    computeUnitsConsumed?: number;
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RawIx[] } };
}

export interface Realized {
  signature: string;
  landed: boolean;
  success: boolean;
  err: unknown;
  slot?: number;
  blockTime?: number | null;
  kind: Direction | "other";
  fee: bigint;
  /** Δ of the user's wSOL token account (raw token amount, excludes rent lamports). */
  wsolDelta: bigint;
  /** Δ of the user's RISE token account. */
  riseDelta: bigint;
  /** Δ of the user's native SOL balance (includes -fee). */
  nativeDelta: bigint;
  /** wsolDelta + nativeDelta: realized lamports PnL, fee included. */
  netLamports: bigint;
  computeUnits?: number;
}

export function accountKeysOf(t: RawTx): string[] {
  const la = t.meta?.loadedAddresses;
  return [...t.transaction.message.accountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])];
}

function tokenAmount(list: RawTokenBalance[] | null | undefined, idx: number): bigint {
  const b = list?.find((x) => x.accountIndex === idx);
  return b ? BigInt(b.uiTokenAmount.amount) : 0n;
}

export function classify(t: RawTx): Direction | "other" {
  const keys = accountKeysOf(t);
  const progs = t.transaction.message.instructions.map((ix) => keys[ix.programIdIndex]).filter((p) => p === RISE_PROGRAM_ID || p === DLMM_PROGRAM_ID);
  if (progs.length === 2 && progs[0] === RISE_PROGRAM_ID && progs[1] === DLMM_PROGRAM_ID) return "mintThenSell";
  if (progs.length === 2 && progs[0] === DLMM_PROGRAM_ID && progs[1] === RISE_PROGRAM_ID) return "buyThenRedeem";
  return "other";
}

/** Realized numbers for `user` from a landed tx. */
export function analyzeTx(t: RawTx, user: string, wsolAta: string, riseAta: string): Realized {
  const signature = t.transaction.signatures[0];
  const m = t.meta;
  if (!m) throw new Error(`tx ${signature} has no meta`);
  const keys = accountKeysOf(t);
  const tokDelta = (ata: string) => {
    const i = keys.indexOf(ata);
    return i < 0 ? 0n : tokenAmount(m.postTokenBalances, i) - tokenAmount(m.preTokenBalances, i);
  };
  const ui = keys.indexOf(user);
  const nativeDelta = ui < 0 ? 0n : BigInt(m.postBalances[ui]) - BigInt(m.preBalances[ui]);
  const wsolDelta = tokDelta(wsolAta);
  const riseDelta = tokDelta(riseAta);
  // fee is only borne by user if user is the fee payer (index 0)
  const fee = keys[0] === user ? BigInt(m.fee) : 0n;
  return {
    signature, landed: true, success: m.err === null || m.err === undefined, err: m.err ?? null,
    slot: t.slot, blockTime: t.blockTime, kind: classify(t),
    fee, wsolDelta, riseDelta, nativeDelta, netLamports: wsolDelta + nativeDelta, computeUnits: m.computeUnitsConsumed,
  };
}

export function droppedOutcome(signature: string, kind: Direction | "other"): Realized {
  return { signature, landed: false, success: false, err: null, kind, fee: 0n, wsolDelta: 0n, riseDelta: 0n, nativeDelta: 0n, netLamports: 0n };
}

/**
 * The sender saw the tx land (status confirmed / failed) but getTransaction never returned it.
 * Recording it as "dropped" would book 0 cost and let the daily execution-cost / loss stops
 * under-count. Instead record it as landed with the budgeted fee (+ tip on success) as the
 * only, worst-case, SOL change; token deltas unknown (0). Flagged `estimated`.
 */
export function unrealizedLandedOutcome(signature: string, kind: Direction | "other", status: "confirmed" | "failed", feeLamports: bigint, tipLamports: bigint): Realized & { estimated: true } {
  const success = status === "confirmed";
  const nativeDelta = -(feeLamports + (success ? tipLamports : 0n));
  return { signature, landed: true, success, err: success ? null : "unknown (getTransaction unavailable)", kind, fee: feeLamports, wsolDelta: 0n, riseDelta: 0n, nativeDelta, netLamports: nativeDelta, estimated: true };
}

/** Raw JSON-RPC getTransaction (same shape as saved reference txs). */
export async function fetchRawTx(conn: Connection, signature: string, commitment: "confirmed" | "finalized" = "confirmed"): Promise<RawTx | null> {
  const rpc = (conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<{ result?: RawTx | null; error?: { message: string } }> })._rpcRequest;
  const res = await rpc.call(conn, "getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment }]);
  if (res.error) throw new Error(`getTransaction: ${res.error.message}`);
  return res.result ?? null;
}

/** Fetch with retries (a just-confirmed tx can briefly be unavailable from getTransaction). */
export async function fetchRealized(
  conn: Connection, signature: string, user: string, wsolAta: string, riseAta: string,
  o: { attempts?: number; delayMs?: number; kind?: Direction | "other" } = {},
): Promise<Realized> {
  const attempts = o.attempts ?? 10;
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await fetchRawTx(conn, signature);
      if (raw) return analyzeTx(raw, user, wsolAta, riseAta);
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, o.delayMs ?? 1500));
  }
  return droppedOutcome(signature, o.kind ?? "other");
}

// ---------- summaries ----------

export interface PnlSummary {
  submitted: number;
  landed: number;
  succeeded: number;
  failedLanded: number;
  dropped: number;
  /** Σ wSOL Δ of successful txs (before fees). */
  grossLamports: bigint;
  /** Σ fees of all landed txs. */
  feesLamports: bigint;
  /** Σ fees of failed-but-landed txs (subset of feesLamports). */
  failedCostLamports: bigint;
  /** Σ (wSOL Δ + native Δ) over all outcomes = gross − fees. */
  netLamports: bigint;
  /** RISE residual accumulated (raw units) and its estimated lamport value at the per-trade mark. */
  riseDelta: bigint;
  riseValueEstLamports: bigint;
  wins: number;
  winRate: number;
  byKind: Record<string, { n: number; net: bigint; fees: bigint; failed: number }>;
}

export interface OutcomeLike extends Realized {
  /** lamports per RISE base unit * 1e9 at trade time (mark for valuing RISE residual), optional. */
  riseMarkLamportsPerRiseE9?: bigint;
}

export function summarize(outs: OutcomeLike[]): PnlSummary {
  const s: PnlSummary = {
    submitted: outs.length, landed: 0, succeeded: 0, failedLanded: 0, dropped: 0,
    grossLamports: 0n, feesLamports: 0n, failedCostLamports: 0n, netLamports: 0n,
    riseDelta: 0n, riseValueEstLamports: 0n, wins: 0, winRate: 0, byKind: {},
  };
  for (const o of outs) {
    const k = (s.byKind[o.kind] ??= { n: 0, net: 0n, fees: 0n, failed: 0 });
    k.n++;
    if (!o.landed) { s.dropped++; continue; }
    s.landed++;
    s.feesLamports += o.fee;
    k.fees += o.fee;
    s.netLamports += o.netLamports;
    k.net += o.netLamports;
    s.riseDelta += o.riseDelta;
    if (o.riseMarkLamportsPerRiseE9 !== undefined) s.riseValueEstLamports += (o.riseDelta * o.riseMarkLamportsPerRiseE9) / 1_000_000_000n;
    if (o.success) {
      s.succeeded++;
      s.grossLamports += o.wsolDelta;
      if (o.netLamports > 0n) s.wins++;
    } else {
      s.failedLanded++;
      s.failedCostLamports += o.fee;
      k.failed++;
    }
  }
  s.winRate = s.landed ? s.wins / s.landed : 0;
  return s;
}

/** Revive bigint fields of an outcome event read back from JSONL. */
export function outcomeFromEvent(e: LedgerEvent): OutcomeLike {
  const b = (x: unknown) => BigInt((x as string | number | undefined) ?? 0);
  return {
    signature: String(e.signature), landed: Boolean(e.landed), success: Boolean(e.success), err: e.err ?? null,
    slot: e.slot as number | undefined, blockTime: e.blockTime as number | undefined,
    kind: (e.kind as Direction | "other") ?? "other",
    fee: b(e.fee), wsolDelta: b(e.wsolDelta), riseDelta: b(e.riseDelta), nativeDelta: b(e.nativeDelta), netLamports: b(e.netLamports),
    riseMarkLamportsPerRiseE9: e.riseMarkLamportsPerRiseE9 === undefined ? undefined : b(e.riseMarkLamportsPerRiseE9),
  };
}

// ---------- per-outcome reconciliation and cost breakdown ----------

/** What the bot expected a submission to do (from the final simulation and the built tx). */
export interface ExpectedEffect {
  /** Simulated Δ wSOL (token amount). */
  wsolDelta: bigint;
  /** Simulated Δ RISE. */
  riseDelta: bigint;
  /** Fee of the built tx (base + priority). */
  feeLamports: bigint;
  baseFeeLamports: bigint;
  tipLamports: bigint;
}

export interface Reconciled {
  /** wSOL Δ + native Δ + fee + tip: what the trade itself made (0 for failed/dropped). */
  tradingProfitLamports: bigint;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
  /** Measured: −native Δ − fee on a successful landed tx; a failed tx reverts the tip. */
  tipLamports: bigint;
  /** fee + tip actually paid. */
  execCostLamports: bigint;
  /** Execution cost of a landed-but-failed tx (subset of execCost); dropped/expired = 0. */
  failedCostLamports: bigint;
  /** RISE Δ, valued separately, never counted in realized SOL. */
  residualRise: bigint;
  /** actual − expected (only meaningful for successful landed txs; failed: vs a zero-token, fee-only expectation). */
  drift: { wsol: bigint; rise: bigint; native: bigint };
}

export function reconcileOutcome(r: Realized, e: ExpectedEffect): Reconciled {
  if (!r.landed) {
    return { tradingProfitLamports: 0n, baseFeeLamports: 0n, priorityFeeLamports: 0n, tipLamports: 0n, execCostLamports: 0n, failedCostLamports: 0n, residualRise: 0n, drift: { wsol: 0n, rise: 0n, native: 0n } };
  }
  const base = r.fee < e.baseFeeLamports ? r.fee : e.baseFeeLamports;
  const priority = r.fee - base;
  const measuredTip = r.success ? -r.nativeDelta - r.fee : 0n;
  const tip = measuredTip > 0n ? measuredTip : 0n;
  const exec = r.fee + tip;
  const expW = r.success ? e.wsolDelta : 0n;
  const expR = r.success ? e.riseDelta : 0n;
  const expN = -(e.feeLamports + (r.success ? e.tipLamports : 0n));
  return {
    tradingProfitLamports: r.netLamports + exec,
    baseFeeLamports: base, priorityFeeLamports: priority, tipLamports: tip,
    execCostLamports: exec, failedCostLamports: r.success ? 0n : exec,
    residualRise: r.riseDelta,
    drift: { wsol: r.wsolDelta - expW, rise: r.riseDelta - expR, native: r.nativeDelta - expN },
  };
}

export interface PnlBreakdown {
  submitted: number;
  landed: number;
  succeeded: number;
  failedLanded: number;
  dropped: number;
  /** Realized trading profit (before execution costs) of successful txs. */
  tradingProfitLamports: bigint;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
  tipLamports: bigint;
  /** base + priority + tip, all landed txs. */
  execCostLamports: bigint;
  /** Execution cost of landed-but-failed txs (subset of execCost). */
  failedCostLamports: bigint;
  /** Realized SOL: trading profit − execution costs (= Σ wSOL Δ + native Δ). */
  netLamports: bigint;
  /** RISE residue (raw) and its estimated value at trade-time marks — NOT in netLamports. */
  residualRise: bigint;
  residualRiseValueEstLamports: bigint;
  /** Σ |drift| vs expectation over successful txs, per asset. */
  absDrift: { wsol: bigint; rise: bigint; native: bigint };
  driftTxs: number;
}

const big0 = (x: unknown) => BigInt((x as string | number | undefined) ?? 0);
const absb = (x: bigint) => (x < 0n ? -x : x);

/**
 * Breakdown over outcome ledger rows. Rows written before reconciliation existed
 * (no `exec` field) are treated as tip 0 with base fee min(fee, 5000).
 */
export function breakdown(outcomes: LedgerEvent[]): PnlBreakdown {
  const s: PnlBreakdown = {
    submitted: 0, landed: 0, succeeded: 0, failedLanded: 0, dropped: 0,
    tradingProfitLamports: 0n, baseFeeLamports: 0n, priorityFeeLamports: 0n, tipLamports: 0n, execCostLamports: 0n, failedCostLamports: 0n,
    netLamports: 0n, residualRise: 0n, residualRiseValueEstLamports: 0n, absDrift: { wsol: 0n, rise: 0n, native: 0n }, driftTxs: 0,
  };
  for (const e of outcomes) {
    s.submitted++;
    if (!e.landed) { s.dropped++; continue; }
    s.landed++;
    const fee = big0(e.fee);
    const ex = e.exec as Record<string, unknown> | undefined;
    const base = ex ? big0(ex.base) : fee < 5_000n ? fee : 5_000n;
    const prio = ex ? big0(ex.priority) : fee - base;
    const tip = ex ? big0(ex.tip) : 0n;
    const net = big0(e.netLamports);
    s.baseFeeLamports += base;
    s.priorityFeeLamports += prio;
    s.tipLamports += tip;
    s.execCostLamports += base + prio + tip;
    s.netLamports += net;
    const rise = big0(e.riseDelta);
    s.residualRise += rise;
    if (e.riseMarkLamportsPerRiseE9 !== undefined) s.residualRiseValueEstLamports += (rise * big0(e.riseMarkLamportsPerRiseE9)) / 1_000_000_000n;
    if (e.success) {
      s.succeeded++;
      s.tradingProfitLamports += net + base + prio + tip;
      const d = e.drift as Record<string, unknown> | undefined;
      if (d) {
        s.driftTxs++;
        s.absDrift.wsol += absb(big0(d.wsol));
        s.absDrift.rise += absb(big0(d.rise));
        s.absDrift.native += absb(big0(d.native));
      }
    } else {
      s.failedLanded++;
      s.failedCostLamports += base + prio + tip;
      // a failed tx's "trading profit" is 0; its net is −cost
      s.tradingProfitLamports += net + base + prio + tip;
    }
  }
  return s;
}

/**
 * Startup reconcile: on-chain wSOL / RISE vs (last balances snapshot for this user
 * + Σ outcome token deltas after it). Returns null without a baseline.
 */
export function reconcileBalances(events: LedgerEvent[], user: string, onchain: { wsol: bigint; rise: bigint }): { baselineTs: string; expected: { wsol: bigint; rise: bigint }; drift: { wsol: bigint; rise: bigint }; outcomesSince: number } | null {
  let bi = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "balances" && events[i].user === user) { bi = i; break; }
  if (bi < 0) return null;
  const b = events[bi];
  let wsol = big0(b.wsol), rise = big0(b.rise), n = 0;
  for (const e of events.slice(bi + 1)) {
    if (e.type !== "outcome" || !e.landed) continue;
    if (e.user !== undefined && e.user !== user) continue;
    wsol += big0(e.wsolDelta);
    rise += big0(e.riseDelta);
    n++;
  }
  return { baselineTs: b.ts, expected: { wsol, rise }, drift: { wsol: onchain.wsol - wsol, rise: onchain.rise - rise }, outcomesSince: n };
}

/**
 * Multi-pair balance reconcile. A `balances` snapshot (type "balances", same user) records the
 * wSOL balance and every pair's token balance (`tokens: { [pair]: amount }`; older snapshots with
 * only `rise` are read as `tokens.rise`). Expected now = snapshot + Σ landed outcomes since it:
 * wSOL from every pair (the wSOL account is shared), token deltas per pair (outcomes without a
 * `pair` field are RISE engine outcomes). Pairs absent from the snapshot are reported but not
 * reconciled (no baseline yet).
 */
export function reconcileTokenBalances(
  events: LedgerEvent[],
  user: string,
  onchain: { wsol: bigint; tokens: Record<string, bigint> },
): { baselineTs: string; expected: { wsol: bigint; tokens: Record<string, bigint> }; drift: { wsol: bigint; tokens: Record<string, bigint> }; noBaseline: string[]; outcomesSince: number } | null {
  let bi = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "balances" && events[i].user === user) { bi = i; break; }
  if (bi < 0) return null;
  const b = events[bi];
  const base: Record<string, bigint> = {};
  const snapTokens = (b.tokens ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(snapTokens)) base[k] = big0(v);
  if (b.rise !== undefined && base.rise === undefined) base.rise = big0(b.rise);
  let wsol = big0(b.wsol), n = 0;
  const exp: Record<string, bigint> = { ...base };
  for (const e of events.slice(bi + 1)) {
    if (e.type !== "outcome" || !e.landed) continue;
    if (e.user !== undefined && e.user !== user) continue;
    wsol += big0(e.wsolDelta);
    const pair = typeof e.pair === "string" ? e.pair : "rise";
    if (exp[pair] !== undefined) exp[pair] += big0(e.riseDelta);
    n++;
  }
  const drift: Record<string, bigint> = {};
  const noBaseline: string[] = [];
  for (const [pair, amt] of Object.entries(onchain.tokens)) {
    if (exp[pair] === undefined) { noBaseline.push(pair); continue; }
    drift[pair] = amt - exp[pair];
  }
  return { baselineTs: b.ts, expected: { wsol, tokens: exp }, drift: { wsol: onchain.wsol - wsol, tokens: drift }, noBaseline, outcomesSince: n };
}
