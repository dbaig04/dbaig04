// Background blockhash cache: keeps a recent blockhash ready so building a tx never
// waits on RPC. Refreshes every `refreshMs` (and on demand via onSlot()), marks the
// cached value stale after `staleMs`; a stale or missing value makes get() return null
// and the caller falls back to a synchronous fetch (counted in `syncFetches`).
import type { Commitment, Connection } from "@solana/web3.js";

export type BlockhashConnection = Pick<Connection, "getLatestBlockhash">;

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  /** performance.now() when it was fetched. */
  fetchedAt: number;
}

export interface BlockhashCacheOptions {
  refreshMs?: number;
  staleMs?: number;
  commitment?: Commitment;
  now?: () => number;
  log?: (m: string) => void;
}

export class BlockhashCache {
  private cur: CachedBlockhash | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<CachedBlockhash | null> | null = null;
  readonly refreshMs: number;
  readonly staleMs: number;
  private now: () => number;
  /** Background refreshes done / failed, and synchronous fallbacks (cache miss on the hot path). */
  refreshes = 0;
  failures = 0;
  syncFetches = 0;

  constructor(private conn: BlockhashConnection, private o: BlockhashCacheOptions = {}) {
    this.refreshMs = o.refreshMs ?? 2_000;
    this.staleMs = o.staleMs ?? 20_000;
    this.now = o.now ?? (() => performance.now());
  }

  /** Start background refresh (first fetch immediately). Timer is unref'd. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Fetch now (coalesced with one already in flight). Never throws. */
  refresh(): Promise<CachedBlockhash | null> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const r = await this.conn.getLatestBlockhash(this.o.commitment ?? "confirmed");
        this.cur = { blockhash: r.blockhash, lastValidBlockHeight: r.lastValidBlockHeight, fetchedAt: this.now() };
        this.refreshes++;
        return this.cur;
      } catch (e) {
        this.failures++;
        this.o.log?.(`blockhash refresh failed: ${(e as Error).message}`);
        return null;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** New slot seen: refresh early if the cached value is older than half the period. */
  onSlot(): void {
    if (this.cur && this.now() - this.cur.fetchedAt < this.refreshMs / 2) return;
    void this.refresh();
  }

  /** Cached value if fresh, else null (no I/O). */
  get(): CachedBlockhash | null {
    if (!this.cur || this.now() - this.cur.fetchedAt > this.staleMs) return null;
    return this.cur;
  }

  /** Cached value, or a synchronous fetch when missing/stale. */
  async getOrFetch(): Promise<CachedBlockhash> {
    const c = this.get();
    if (c) return c;
    this.syncFetches++;
    const r = await this.refresh();
    if (!r) {
      // last resort: surface the RPC error to the caller
      const x = await this.conn.getLatestBlockhash(this.o.commitment ?? "confirmed");
      this.cur = { blockhash: x.blockhash, lastValidBlockHeight: x.lastValidBlockHeight, fetchedAt: this.now() };
      return this.cur;
    }
    return r;
  }

  ageMs(): number | null {
    return this.cur ? this.now() - this.cur.fetchedAt : null;
  }
}
