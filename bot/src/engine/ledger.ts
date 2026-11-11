// Append-only JSONL ledger of every opportunity, simulation, submission and
// outcome. Realized PnL is computed from the landed transaction itself
// (getTransaction meta: fee, pre/post token + native balances), never from quotes.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Connection } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, RISE_PROGRAM_ID, type Direction } from "../types.js";

export type LedgerEventType = "start" | "stop" | "opportunity" | "simulation" | "submission" | "outcome" | "error" | "latency" | "hold";

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

/** Raw JSON-RPC getTransaction (same shape as saved reference txs). */
export async function fetchRawTx(conn: Connection, signature: string, commitment: "confirmed" | "finalized" = "confirmed"): Promise<RawTx | null> {
  const rpc = (conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<{ result?: RawTx | null; error?: { message: string } }> })._rpcRequest;
  const res = await rpc.call(conn, "getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment }]);
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
