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

export class CompetitorWatcher {
  private last: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  readonly arbs: CompetitorArb[] = [];
  seen = 0;
  constructor(private rpc: RateLimitedRpc, private o: { watch: string; pumpPool: string; dlmmPool: string; txDir: string; outPath: string; tips?: Set<string>; log?: (m: string) => void; intervalMs?: number }) {
    mkdirSync(dirname(o.outPath), { recursive: true });
  }
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sigs: SigInfo[] = await signaturesFor(this.rpc, this.o.watch, { max: this.last ? 1000 : 1, until: this.last });
      if (!sigs.length) return;
      if (!this.last) { this.last = sigs[0].signature; return; } // start point: only txs after the run started
      this.last = sigs[0].signature;
      for (const s of sigs.reverse()) {
        this.seen++;
        const t = (await getTxCached(this.rpc, s.signature, this.o.txDir)) as RawTxV1 | null;
        if (!t?.meta) continue;
        const a = analyzeTx(t, { jitoTipAccounts: this.o.tips });
        const arb = maxArbOf(a, this.o.pumpPool, this.o.dlmmPool);
        if (!arb || arb.direction === "mixed") continue; // both pools traded the same way: a routed swap, not an arb
        const rec = { ...arb, fetchedAt: Date.now() };
        this.arbs.push(rec);
        appendFileSync(this.o.outPath, JSON.stringify(rec) + "\n");
        this.o.log?.(`competitor arb ${rec.direction} slot ${rec.slot} by ${rec.feePayer.slice(0, 8)} net ${rec.walletSolNet} ok=${rec.success}`);
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
