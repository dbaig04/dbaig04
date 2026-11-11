// Meteora DLMM venue for the RISE/SOL pool (4xjgBH...). Pure, synchronous quoting over cached
// account snapshots (no I/O). See NOTES.md for the fee model and validation evidence.
import { AccountInfo, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { DlmmVenue } from "../types.js";
import { RISE_MINT, WSOL_MINT } from "../types.js";
import {
  BinArrayState,
  ClockState,
  LbPairState,
  MintInfo,
  decodeBinArray,
  decodeClock,
  decodeLbPair,
  decodeMint,
  MAX_BIN_PER_ARRAY,
} from "./layout.js";
import {
  HOST_FEE_BPS,
  BASIS_POINT_MAX,
  binMaxOut,
  binView,
  swapExactInAtBin,
  swapExactOutAtBin,
  totalFeeRate,
  transferFeeExcluded,
  transferFeeIncluded,
  updateReference,
  updateVolatilityAccumulator,
} from "./math.js";
import {
  EVENT_AUTHORITY,
  MEMO_PROGRAM,
  POOL,
  PROGRAM,
  SYSVAR_CLOCK,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ata,
  binArrayPda,
  binIdToBinArrayIndex,
} from "./pda.js";

export type Side = "sellRise" | "buyRise";

export interface QuoteDetail {
  /** Total trading fee (input token when fee-on-input), incl. protocol + host share. */
  fee: bigint;
  /** Protocol fee as the program reports it (host share already removed when a host account is passed). */
  protocolFee: bigint;
  /** Host fee (20% of protocol fee). Paid back to host_fee_in, which our ixs set to the user's input ATA. */
  hostFee: bigint;
  /** Bin id of the last bin that was swapped in. */
  endBinId: number;
  /** Fee rate (1e9 precision) applied in the last bin. */
  lastFeeRate: bigint;
}

export interface ExactInQuote extends QuoteDetail {
  out: bigint;
  binArrays: PublicKey[];
  /** Net decrease of the user's input token balance (amountIn - host fee rebate, if enabled). */
  netIn: bigint;
}

export interface ExactOutQuote extends QuoteDetail {
  inp: bigint;
  binArrays: PublicKey[];
  /** Net decrease of the user's input token balance (inp - host fee rebate, if enabled). */
  netIn: bigint;
}

export interface MeteoraDlmmOptions {
  /** Fetch initialized bin arrays within +-N array indices of the active array (default 12 = 840 bins). */
  binArrayWindow?: number;
  /** Extra bin arrays (beyond the ones the quote traverses) appended in swap direction (default 1). */
  extraBinArrays?: number;
  /** Pass the user's input token account as host_fee_in so the 20% host share of the protocol fee
   *  is refunded to the user (what the reference wallet does). Default true. */
  hostFeeRebate?: boolean;
}

interface BinTrace {
  ai: number;
  j: number;
  toBin: bigint;
  fromBin: bigint;
}

const SWAP2_DISC = Buffer.from("414b3f4ceb5b5b88", "hex");
const SWAP_EXACT_OUT2_DISC = Buffer.from("2bd7f784893cf351", "hex");
const RISE = new PublicKey(RISE_MINT);
const WSOL = new PublicKey(WSOL_MINT);

export class MeteoraDlmm implements DlmmVenue {
  readonly pool = POOL;
  readonly opts: Required<MeteoraDlmmOptions>;
  slot = 0;
  lbPair: LbPairState | null = null;
  clock: ClockState | null = null;
  mintX: MintInfo | null = null;
  mintY: MintInfo | null = null;
  /** bin array index -> decoded bin array (only those present in the last snapshot) */
  binArrays = new Map<number, BinArrayState>();
  private wanted: PublicKey[] = [];
  private initializedIdx: number[] = [];
  /** last raw bytes + decoded form per bin array index, to skip re-decoding unchanged arrays */
  private rawCache = new Map<number, { raw: Buffer; ba: BinArrayState }>();
  private lbRaw: Buffer | null = null;
  private lbDecoded: LbPairState | null = null;
  private mintRaw: Buffer | null = null;
  /** Bumped whenever lb_pair, the RISE mint, a cached bin array or the cached set changes (or applySwap). */
  stateVersion = 0;
  /** Per-user ATA cache for instruction building (PDA derivation is ~0.1-0.5 ms each). */
  private ataCache = new Map<string, { rise: PublicKey; wsol: PublicKey }>();

  constructor(opts: MeteoraDlmmOptions = {}) {
    this.opts = { binArrayWindow: 12, extraBinArrays: 1, hostFeeRebate: true, ...opts };
  }

  // ---------------- StateSource ----------------

  accounts(): PublicKey[] {
    return [POOL, SYSVAR_CLOCK, RISE, ...this.wanted];
  }

  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    const p = infos.get(POOL.toBase58());
    if (!p) throw new Error("DLMM lb_pair missing from snapshot");
    const rawChanged = !this.lbRaw || !this.lbRaw.equals(p.data) || !this.lbDecoded;
    const lb = rawChanged ? decodeLbPair(p.data) : this.lbDecoded!;
    if (!lb.tokenXMint.equals(RISE) || !lb.tokenYMint.equals(WSOL)) throw new Error("unexpected pool mints");
    if (rawChanged) { this.lbRaw = Buffer.from(p.data); this.lbDecoded = lb; }
    // also "changed" when the cached lbPair was advanced by applySwap
    let changed = rawChanged || this.lbPair !== lb;
    this.lbPair = lb;
    this.slot = slot;
    const c = infos.get(SYSVAR_CLOCK.toBase58());
    if (c) this.clock = decodeClock(c.data);
    const m = infos.get(RISE.toBase58());
    if (m && (!this.mintRaw || !this.mintRaw.equals(m.data))) {
      this.mintX = decodeMint(m.data);
      this.mintRaw = Buffer.from(m.data);
      changed = true;
    }
    this.mintY = null; // wSOL: classic SPL token, no extensions

    // initialized bin arrays from the internal bitmap (bit i <-> index i-512)
    const idx: number[] = [];
    for (let w = 0; w < 16; w++) {
      let word = lb.binArrayBitmap[w];
      for (let b = 0; word !== 0n; b++, word >>= 1n) if (word & 1n) idx.push(w * 64 + b - 512);
    }
    this.initializedIdx = idx;
    const activeIdx = binIdToBinArrayIndex(lb.activeId);
    const win = this.opts.binArrayWindow;
    const wantIdx = idx.filter((i) => Math.abs(i - activeIdx) <= win);
    this.wanted = wantIdx.map((i) => binArrayPda(i));

    const next = new Map<number, BinArrayState>();
    for (const i of wantIdx) {
      const a = infos.get(binArrayPda(i).toBase58());
      if (!a) continue; // not in this snapshot (first tick) -> fetched next tick
      const cached = this.rawCache.get(i);
      if (cached && cached.raw.equals(a.data)) {
        next.set(i, cached.ba);
        continue;
      }
      const ba = decodeBinArray(a.data);
      if (ba.index !== i || !ba.lbPair.equals(POOL)) throw new Error(`bin array ${i} mismatch`);
      changed = true;
      this.rawCache.set(i, { raw: Buffer.from(a.data), ba });
      next.set(i, ba);
    }
    for (const k of this.rawCache.keys()) if (!next.has(k)) this.rawCache.delete(k);
    if (next.size !== this.binArrays.size || [...next.keys()].some((k) => next.get(k) !== this.binArrays.get(k))) changed = true;
    this.binArrays = next;
    if (changed) this.stateVersion++;
  }

  /**
   * Key that changes whenever a quote could change: state version + the clock-derived
   * volatility references (fees depend on the time since the last swap) + epoch (transfer fees).
   * Equal keys => identical quotes.
   */
  quoteKey(): string {
    const lb = this.lbPair;
    if (!lb || !this.clock) return `none:${this.stateVersion}`;
    const v = updateReference(lb.v, lb.s, lb.activeId, this.clock.unixTimestamp);
    return `${this.stateVersion}:${v.indexReference}:${v.volatilityReference}:${v.volatilityAccumulator}:${this.clock.epoch}`;
  }

  /** Base (minimum, VA = 0) fee rate, 1e9 precision. The fee rate of any bin is >= this. */
  baseFeeRate(): bigint | null {
    const lb = this.lbPair;
    return lb ? totalFeeRate(lb.binStep, lb.s, 0) : null;
  }

  /** True once lb_pair, clock and the bin arrays around the active bin are cached. */
  ready(): boolean {
    return !!this.lbPair && !!this.clock && this.binArrays.has(binIdToBinArrayIndex(this.lbPair.activeId));
  }

  // ---------------- quoting ----------------

  private checkTradable(): LbPairState | null {
    const lb = this.lbPair;
    if (!lb || !this.clock) return null;
    if (lb.status !== 0) return null; // PairStatus::Enabled = 0
    const now = lb.activationType === 0 ? this.clock.slot : BigInt(this.clock.unixTimestamp);
    if (now < lb.activationPoint) return null;
    if (this.mintX?.transferHookProgram) return null; // transfer hook would need extra accounts
    return lb;
  }

  private supportLimitOrder(lb: LbPairState): boolean {
    if (lb.s.functionType === 2) return true;
    if (lb.s.functionType === 1) return false;
    return lb.rewardMints.every((m) => m.equals(PublicKey.default));
  }

  private feeOnInput(lb: LbPairState, swapForY: boolean): boolean {
    if (lb.s.collectFeeMode === 0) return true; // InputOnly
    if (lb.s.collectFeeMode === 1) return !swapForY; // OnlyY
    throw new Error("unknown collect fee mode");
  }

  /**
   * Core loop. mode "in": `amount` is fee-excluded-of-transfer-fee input; "out": desired output (gross of transfer fee).
   * Returns null when the cached bin arrays cannot cover the trade.
   */
  private run(swapForY: boolean, mode: "in" | "out", amount: bigint, trace?: BinTrace[]) {
    const lb = this.checkTradable();
    if (!lb || amount <= 0n) return null;
    const s = lb.s;
    const binStep = lb.binStep;
    const protocolShare = BigInt(s.protocolShare);
    const slo = this.supportLimitOrder(lb);
    const foi = this.feeOnInput(lb, swapForY);
    const v = updateReference(lb.v, s, lb.activeId, this.clock!.unixTimestamp);

    // limits of initialized arrays in the swap direction
    const initialized = this.initializedIdx;
    if (initialized.length === 0) return null;
    const lastIdx = swapForY ? initialized[0] : initialized[initialized.length - 1];

    let activeId = lb.activeId;
    let left = amount;
    let totalIn = 0n;
    let totalOut = 0n;
    let fee = 0n;
    let protocolFee = 0n;
    let hostFee = 0n;
    let lastRate = 0n;
    let endBinId = activeId;
    const used: number[] = [];
    const step = swapForY ? -1 : 1;

    while (left > 0n) {
      const ai = binIdToBinArrayIndex(activeId);
      if (swapForY ? ai < lastIdx : ai > lastIdx) return null; // ran out of liquidity
      if (activeId < s.minBinId || activeId > s.maxBinId) return null;
      const ba = this.binArrays.get(ai);
      if (!ba) {
        if (initialized.includes(ai)) return null; // exists on chain but not cached -> can't quote
        // uninitialized array: jump to its edge
        activeId = swapForY ? ai * MAX_BIN_PER_ARRAY - 1 : (ai + 1) * MAX_BIN_PER_ARRAY;
        continue;
      }
      if (used[used.length - 1] !== ai) used.push(ai);
      const lower = ai * MAX_BIN_PER_ARRAY;
      // walk bins inside this array
      while (left > 0n) {
        const bin = ba.bins[activeId - lower];
        const view = binView(bin, swapForY, slo && ba.version >= 3);
        if (binMaxOut(view) > 0n) {
          updateVolatilityAccumulator(v, s, activeId);
          const rate = totalFeeRate(binStep, s, v.volatilityAccumulator);
          const r =
            mode === "in"
              ? swapExactInAtBin(view, rate, protocolShare, left, swapForY, foi)
              : swapExactOutAtBin(view, rate, protocolShare, left, swapForY, foi);
          if (mode === "in" ? r.amountIn > 0n : r.amountOut > 0n) {
            left -= mode === "in" ? r.amountIn : r.amountOut;
            totalIn += r.amountIn;
            totalOut += r.amountOut;
            fee += r.fee;
            protocolFee += r.protocolFee;
            // host fee is split off per bin (floor per bin), not on the swap total
            if (this.opts.hostFeeRebate) hostFee += (r.protocolFee * HOST_FEE_BPS) / BASIS_POINT_MAX;
            lastRate = rate;
            endBinId = activeId;
            trace?.push({ ai, j: activeId - lower, toBin: r.amountIn - r.fee, fromBin: r.binOut ?? r.amountOut });
          }
        }
        if (left === 0n) break;
        activeId += step;
        if (activeId < lower || activeId >= lower + MAX_BIN_PER_ARRAY) break;
      }
    }

    // bin arrays: traversed ones (in swap order) + extras in swap direction
    const keys = used.map((i) => binArrayPda(i));
    let extra = this.opts.extraBinArrays;
    const after = used[used.length - 1];
    const dirIdx = swapForY ? initialized.filter((i) => i < after).reverse() : initialized.filter((i) => i > after);
    for (const i of dirIdx) {
      if (extra-- <= 0) break;
      keys.push(binArrayPda(i));
    }
    return { totalIn, totalOut, fee, protocolFee: protocolFee - hostFee, hostFee, endBinId, lastRate, keys, finalActiveId: activeId, v };
  }

  quoteExactIn(side: Side, amountIn: bigint): ExactInQuote | null {
    const swapForY = side === "sellRise";
    const [inMint, outMint] = swapForY ? [this.mintX, this.mintY] : [this.mintY, this.mintX];
    const epoch = this.clock?.epoch ?? 0n;
    const r = this.run(swapForY, "in", transferFeeExcluded(inMint, epoch, amountIn));
    if (!r) return null;
    return {
      out: transferFeeExcluded(outMint, epoch, r.totalOut),
      binArrays: r.keys,
      netIn: amountIn - (this.hostFeeToUserIsNet(side) ? r.hostFee : 0n),
      fee: r.fee,
      protocolFee: r.protocolFee,
      hostFee: r.hostFee,
      endBinId: r.endBinId,
      lastFeeRate: r.lastRate,
    };
  }

  quoteExactOut(side: Side, amountOut: bigint): ExactOutQuote | null {
    const swapForY = side === "sellRise";
    const [inMint, outMint] = swapForY ? [this.mintX, this.mintY] : [this.mintY, this.mintX];
    const epoch = this.clock?.epoch ?? 0n;
    const r = this.run(swapForY, "out", transferFeeIncluded(outMint, epoch, amountOut));
    if (!r) return null;
    const inp = transferFeeIncluded(inMint, epoch, r.totalIn);
    return {
      inp,
      binArrays: r.keys,
      netIn: inp - (this.hostFeeToUserIsNet(side) ? r.hostFee : 0n),
      fee: r.fee,
      protocolFee: r.protocolFee,
      hostFee: r.hostFee,
      endBinId: r.endBinId,
      lastFeeRate: r.lastRate,
    };
  }

  /** Host fee is paid in the fee token; with InputOnly fees that is the input token, which is the host account we pass. */
  private hostFeeToUserIsNet(side: Side): boolean {
    const lb = this.lbPair!;
    return this.opts.hostFeeRebate && this.feeOnInput(lb, side === "sellRise");
  }

  /**
   * Advance the cached state as if the swap executed now (bins, active id, volatility params,
   * last_update_timestamp). Useful for quoting a second swap in the same slot/tx. Verified against
   * simulated post-state for MM liquidity; limit-order bookkeeping is not modelled (returns false if
   * the swap touched limit-order liquidity, in which case the state is left unchanged).
   */
  applySwap(side: Side, mode: "exactIn" | "exactOut", amount: bigint): boolean {
    const swapForY = side === "sellRise";
    const trace: BinTrace[] = [];
    const epoch = this.clock?.epoch ?? 0n;
    const [inMint, outMint] = swapForY ? [this.mintX, this.mintY] : [this.mintY, this.mintX];
    const r =
      mode === "exactIn"
        ? this.run(swapForY, "in", transferFeeExcluded(inMint, epoch, amount), trace)
        : this.run(swapForY, "out", transferFeeIncluded(outMint, epoch, amount), trace);
    if (!r) return false;
    const next = new Map(this.binArrays);
    for (const t of trace) {
      const ba0 = next.get(t.ai)!;
      const ba = ba0 === this.binArrays.get(t.ai) ? { ...ba0, bins: ba0.bins.slice() } : ba0;
      const b = { ...ba.bins[t.j] };
      const mm = swapForY ? b.amountY : b.amountX;
      if (t.fromBin > mm) return false; // limit-order liquidity consumed: not modelled
      if (swapForY) {
        b.amountX += t.toBin;
        b.amountY -= t.fromBin;
      } else {
        b.amountY += t.toBin;
        b.amountX -= t.fromBin;
      }
      ba.bins[t.j] = b;
      next.set(t.ai, ba);
    }
    const lb = this.lbPair!;
    this.lbPair = {
      ...lb,
      activeId: r.finalActiveId,
      v: {
        volatilityAccumulator: r.v.volatilityAccumulator,
        volatilityReference: r.v.volatilityReference,
        indexReference: r.v.indexReference,
        lastUpdateTimestamp: this.clock!.unixTimestamp,
      },
    };
    this.binArrays = next;
    this.stateVersion++;
    return true;
  }

  // ---------------- instructions ----------------

  private swapKeys(user: PublicKey, side: Side, binArrays: PublicKey[]) {
    const lb = this.lbPair;
    if (!lb) throw new Error("MeteoraDlmm: no state yet");
    const uk = user.toBase58();
    let a = this.ataCache.get(uk);
    if (!a) {
      a = { rise: ata(user, RISE, TOKEN_2022_PROGRAM), wsol: ata(user, WSOL, TOKEN_PROGRAM) };
      this.ataCache.set(uk, a);
    }
    const userRise = a.rise;
    const userWsol = a.wsol;
    const [tin, tout] = side === "sellRise" ? [userRise, userWsol] : [userWsol, userRise];
    const swapForY = side === "sellRise";
    // host fee is paid in the fee token (input token for InputOnly; Y for OnlyY)
    const feeToken = this.feeOnInput(lb, swapForY) ? tin : userWsol;
    const host = this.opts.hostFeeRebate ? feeToken : PROGRAM;
    const xProg = lb.tokenMintXProgramFlag === 0 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
    const yProg = lb.tokenMintYProgramFlag === 0 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    return [
      w(POOL),
      r(PROGRAM), // bin_array_bitmap_extension = None (all arrays are inside the internal bitmap)
      w(lb.reserveX),
      w(lb.reserveY),
      w(tin),
      w(tout),
      r(lb.tokenXMint),
      r(lb.tokenYMint),
      w(lb.oracle),
      host.equals(PROGRAM) ? r(PROGRAM) : w(host),
      { pubkey: user, isSigner: true, isWritable: false },
      r(xProg),
      r(yProg),
      r(MEMO_PROGRAM),
      r(EVENT_AUTHORITY),
      r(PROGRAM),
      ...binArrays.map(w),
    ];
  }

  private data(disc: Buffer, a: bigint, b: bigint): Buffer {
    const d = Buffer.alloc(8 + 8 + 8 + 4);
    disc.copy(d, 0);
    d.writeBigUInt64LE(a, 8);
    d.writeBigUInt64LE(b, 16);
    d.writeUInt32LE(0, 24); // RemainingAccountsInfo { slices: [] } (no transfer hooks)
    return d;
  }

  swapExactInIx(user: PublicKey, side: Side, amountIn: bigint, minOut: bigint, binArrays: PublicKey[]): TransactionInstruction {
    return new TransactionInstruction({ programId: PROGRAM, keys: this.swapKeys(user, side, binArrays), data: this.data(SWAP2_DISC, amountIn, minOut) });
  }

  swapExactOutIx(user: PublicKey, side: Side, amountOut: bigint, maxIn: bigint, binArrays: PublicKey[]): TransactionInstruction {
    return new TransactionInstruction({ programId: PROGRAM, keys: this.swapKeys(user, side, binArrays), data: this.data(SWAP_EXACT_OUT2_DISC, maxIn, amountOut) });
  }

  // ---------------- introspection ----------------

  /** Liquidity summary of cached bins: output-token depth available per side. */
  depth(): { sellRiseMaxSolOut: bigint; buyRiseMaxRiseOut: bigint; activeId: number; activePrice: number } | null {
    const lb = this.lbPair;
    if (!lb) return null;
    let y = 0n;
    let x = 0n;
    for (const ba of this.binArrays.values())
      ba.bins.forEach((b, j) => {
        const id = ba.index * MAX_BIN_PER_ARRAY + j;
        if (id <= lb.activeId) y += b.amountY;
        if (id >= lb.activeId) x += b.amountX;
      });
    return { sellRiseMaxSolOut: y, buyRiseMaxRiseOut: x, activeId: lb.activeId, activePrice: Math.pow(1 + lb.binStep / 10_000, lb.activeId) };
  }
}

export default MeteoraDlmm;
