// Per-tick state refresh: one getMultipleAccountsInfo (chunked at 100) for the
// union of every StateSource's accounts(), all at a single context slot.
import type { AccountInfo, Commitment, Connection, PublicKey } from "@solana/web3.js";
import type { StateSource } from "../types.js";

export const CHUNK = 100;

/** Minimal connection surface used here (lets tests pass a fake). */
export type StateConnection = Pick<Connection, "getSlot" | "getMultipleAccountsInfoAndContext">;

export interface RefreshResult {
  slot: number;
  /** false when the slot was unchanged and nothing was fetched. */
  updated: boolean;
}

export class StateManager {
  lastSlot = -1;
  /** Max rounds per tick when a source's accounts() grows after an update (e.g. bin arrays). */
  maxRounds = 3;

  constructor(
    private conn: StateConnection,
    private sources: StateSource[],
    private commitment: Commitment = "confirmed",
  ) {}

  private union(): PublicKey[] {
    const seen = new Map<string, PublicKey>();
    for (const s of this.sources) for (const k of s.accounts()) seen.set(k.toBase58(), k);
    return [...seen.values()];
  }

  /** Fetch every account at (or after) minSlot; returns the slot actually served. */
  async fetch(keys: PublicKey[], minSlot?: number): Promise<{ slot: number; infos: Map<string, AccountInfo<Buffer> | null> }> {
    const infos = new Map<string, AccountInfo<Buffer> | null>();
    let slot = minSlot ?? 0;
    let first = true;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const res = await this.conn.getMultipleAccountsInfoAndContext(chunk, {
        commitment: this.commitment,
        ...(first && minSlot === undefined ? {} : { minContextSlot: slot }),
      });
      // Later chunks are pinned to >= the first chunk's slot; the snapshot slot is the max seen.
      slot = Math.max(slot, res.context.slot);
      first = false;
      chunk.forEach((k, j) => infos.set(k.toBase58(), res.value[j] ?? null));
    }
    return { slot, infos };
  }

  /**
   * Refresh all sources. Skips the fetch entirely if the cluster slot has not
   * advanced since the last snapshot.
   */
  async refresh(): Promise<RefreshResult> {
    const cur = await this.conn.getSlot(this.commitment);
    if (cur <= this.lastSlot) return { slot: this.lastSlot, updated: false };
    let keys = this.union();
    let { slot, infos } = await this.fetch(keys, cur);
    for (let round = 0; round < this.maxRounds; round++) {
      for (const s of this.sources) s.update(slot, infos);
      const next = this.union();
      const missing = next.filter((k) => !infos.has(k.toBase58()));
      if (missing.length === 0) break;
      // A source asked for new accounts (e.g. bin arrays around the active bin):
      // refetch everything at the same/next slot so the snapshot stays consistent.
      keys = next;
      ({ slot, infos } = await this.fetch(keys, slot));
    }
    this.lastSlot = slot;
    return { slot, updated: true };
  }
}

/** Decode the u64 `amount` of an SPL Token / Token-2022 account (same base layout). */
export function decodeTokenAmount(data: Buffer | Uint8Array): bigint {
  if (data.length < 72) throw new Error(`token account data too short: ${data.length}`);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(64);
}

/** Tracks the user's wSOL and RISE token-account balances as part of the same snapshot. */
export class TokenBalances implements StateSource {
  wsol: bigint | null = null;
  rise: bigint | null = null;
  slot = -1;
  constructor(readonly wsolAta: PublicKey, readonly riseAta: PublicKey) {}
  accounts(): PublicKey[] {
    return [this.wsolAta, this.riseAta];
  }
  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    this.slot = slot;
    const w = infos.get(this.wsolAta.toBase58());
    const r = infos.get(this.riseAta.toBase58());
    this.wsol = w ? decodeTokenAmount(w.data) : null;
    this.rise = r ? decodeTokenAmount(r.data) : null;
  }
}
