// Competitor arb collector: polls a pool's signatures, fetches new txs (v1-aware), and keeps
// the ones that swap on >= 2 of the pair's pools (closed round trips through both MAX pools).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyzeTx, type RawTxV1, type TxAnalysis } from "./analyze.js";
import { getTxCached, RateLimitedRpc, signaturesFor, type SigInfo } from "./rpc.js";

export const MAX_MINT_ADDR = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump";
export const WSOL_ADDR = "So11111111111111111111111111111111111111112";

export interface CompetitorArb {
  signature: string;
  slot: number;
  blockTime: number | null;
  feePayer: string;
  success: boolean;
  /** "buyPumpSellDlmm" | "buyDlmmSellPump" | other route label */
  direction: string;
  /** SOL into the buy pool / out of the sell pool (pool deltas, lamports), MAX moved. */
  solIn?: number;
  solOut?: number;
  token?: number;
  /** Wallet's realized SOL (wSOL Δ + native Δ, fee + tips included). */
  walletSolNet: number;
  fee: number;
  priorityFee: number;
  jitoTip: number;
  otherLegs: number;
  nonce: boolean;
  fetchedAt: number;
  /** Route (DLMM pool) the arb went through, e.g. "max:H6Bcgd". */
  route?: string;
}

/** Classify a tx as a MAX round trip through both pools (or null). */
export function maxArbOf(a: TxAnalysis, pumpPool: string, dlmmPool: string): Omit<CompetitorArb, "fetchedAt"> | null {
  const p = a.legs.find((l) => l.pool === pumpPool);
  const d = a.legs.find((l) => l.pool === dlmmPool);
  if (!p || !d) return null;
  const sol = (l: typeof p) => Number(l.deltas[WSOL_ADDR] ?? 0);
  const tok = (l: typeof p) => Number(l.deltas[MAX_MINT_ADDR] ?? 0);
  // pool view: + SOL = the trader bought MAX there
  const buyP = sol(p) > 0 && tok(p) < 0, buyD = sol(d) > 0 && tok(d) < 0;
  const direction = buyP && !buyD ? "buyPumpSellDlmm" : buyD && !buyP ? "buyDlmmSellPump" : "mixed";
  const buy = buyP ? p : d, sell = buyP ? d : p;
  return {
    signature: a.signature, slot: a.slot, blockTime: a.blockTime, feePayer: a.feePayer, success: a.success, direction,
    solIn: sol(buy), solOut: -sol(sell), token: -tok(buy),
    walletSolNet: a.walletSolNet, fee: a.fee, priorityFee: a.priorityFee, jitoTip: a.jitoTip, otherLegs: a.legs.length - 2, nonce: !!a.nonce,
  };
}

/** First DLMM pool of `dlmmPools` that, with the PumpSwap pool, forms a round trip in `a`. */
export function maxArbAnyRoute(a: TxAnalysis, pumpPool: string, dlmmPools: readonly string[]): (Omit<CompetitorArb, "fetchedAt"> & { route: string }) | null {
  for (const d of dlmmPools) {
    const r = maxArbOf(a, pumpPool, d);
    if (r && r.direction !== "mixed") return { ...r, route: `max:${d.slice(0, 6)}` };
  }
  return null;
}

export class CompetitorWatcher {
  private last = new Map<string, string>();
  private done = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  readonly arbs: CompetitorArb[] = [];
  seen = 0;
  constructor(private rpc: RateLimitedRpc, private o: { watch: string[]; pumpPool: string; dlmmPools: readonly string[]; txDir: string; outPath: string; tips?: Set<string>; log?: (m: string) => void; intervalMs?: number }) {
    mkdirSync(dirname(o.outPath), { recursive: true });
  }
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const fresh: SigInfo[] = [];
      for (const w of this.o.watch) {
        const last = this.last.get(w);
        const sigs: SigInfo[] = await signaturesFor(this.rpc, w, { max: last ? 1000 : 1, until: last });
        if (!sigs.length) continue;
        this.last.set(w, sigs[0].signature);
        if (!last) continue; // start point: only txs after the run started
        for (const x of sigs) if (!this.done.has(x.signature)) { this.done.add(x.signature); fresh.push(x); }
      }
      fresh.sort((x, y) => x.slot - y.slot);
      for (const s of fresh) {
        this.seen++;
        const t = (await getTxCached(this.rpc, s.signature, this.o.txDir)) as RawTxV1 | null;
        if (!t?.meta) continue;
        const a = analyzeTx(t, { jitoTipAccounts: this.o.tips });
        const arb = maxArbAnyRoute(a, this.o.pumpPool, this.o.dlmmPools); // "mixed" (same way on both pools) = routed swap, not an arb
        if (!arb) continue;
        const rec = { ...arb, fetchedAt: Date.now() };
        this.arbs.push(rec);
        appendFileSync(this.o.outPath, JSON.stringify(rec) + "\n");
        this.o.log?.(`competitor arb ${rec.route} ${rec.direction} slot ${rec.slot} by ${rec.feePayer.slice(0, 8)} net ${rec.walletSolNet} ok=${rec.success}`);
      }
    } catch (e) {
      this.o.log?.(`competitor poll failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.o.intervalMs ?? 20_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  static txDir(base: string) { return join(base, "tx"); }
}
