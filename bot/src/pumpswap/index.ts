// PumpSwap (pump_amm) constant-product pool as a generic SwapVenue: exact, synchronous quotes over
// cached account snapshots (no I/O), and v2 trade instructions:
//   buy  = buy_exact_quote_in_v2(spendable_quote_in = amountIn, min_base_amount_out = minOut)
//   sell = sell_v2(base_amount_in = amountIn, min_quote_amount_out = minOut)
// See NOTES.md for the fee model, account list and validation evidence.
import { AccountInfo, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { SwapQuote, SwapSide, SwapVenue } from "../types.js";
import { WSOL_MINT } from "../types.js";
import { decodeMint, MintInfo } from "../meteora/layout.js";
import { decodeFeeConfig, decodeGlobalConfig, decodePool, FeeConfigState, Fees, GlobalConfigState, PoolState, tokenAmount, mintSupply } from "./layout.js";
import { BuyResult, SellResult, buyExactQuoteIn, computeFees, sellExactBaseIn, FeeContext } from "./math.js";
import {
  EVENT_AUTHORITY,
  FEE_CONFIG,
  GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ata,
  pumpPoolAuthorityPda,
  userVolumeAccumulatorPda,
} from "./pda.js";

export const BUY_EXACT_QUOTE_IN_V2_DISC = Buffer.from([194, 171, 28, 70, 104, 77, 91, 47]);
export const SELL_V2_DISC = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);

const WSOL = new PublicKey(WSOL_MINT);
const U64_MAX = (1n << 64n) - 1n;
const DISABLE_BUY = 1 << 3;
const DISABLE_SELL = 1 << 4;

export interface PumpSwapOptions {
  /** Pool address (e.g. the canonical pool Eoe22Hd... for MAX). */
  pool: PublicKey | string;
  /** Base mint the pool must have (the token; quote must be wSOL). */
  tokenMint: PublicKey | string;
  /** Buyback fee recipient wallet to use (must be listed in GlobalConfig and own an existing quote ATA).
   *  Default: the first listed recipient whose quote ATA exists in the snapshot. */
  buybackRecipient?: PublicKey | string;
}

/** Quote context carried in SwapQuote.ctx. */
export type PumpSwapQuoteCtx = { side: "buy"; r: BuyResult } | { side: "sell"; r: SellResult };

export class PumpSwapPool implements SwapVenue {
  readonly name: string;
  readonly tokenMint: string;
  readonly pool: PublicKey;
  readonly mint: PublicKey;
  slot = 0;
  poolState: PoolState | null = null;
  global: GlobalConfigState | null = null;
  feeConfig: FeeConfigState | null = null;
  baseReserve = 0n;
  quoteVault = 0n;
  baseSupply = 0n;
  baseMintInfo: MintInfo | null = null;
  baseTokenProgram: PublicKey | null = null;
  quoteTokenProgram: PublicKey | null = null;
  /** Bumped whenever any quote-relevant account changes. */
  stateVersion = 0;
  private isPumpPool = false;
  private raw = new Map<string, Buffer>();
  private buybackOverride: PublicKey | null;
  /** chosen buyback recipient's quote ATA (writable account of every v2 trade) */
  buybackAta: PublicKey | null = null;
  private buybackCandidates: PublicKey[] = [];
  private userCache = new Map<string, { base: PublicKey; quote: PublicKey; uva: PublicKey }>();

  constructor(opts: PumpSwapOptions) {
    this.pool = new PublicKey(opts.pool);
    this.mint = new PublicKey(opts.tokenMint);
    this.tokenMint = this.mint.toBase58();
    this.name = `pumpswap:${this.pool.toBase58()}`;
    this.buybackOverride = opts.buybackRecipient ? new PublicKey(opts.buybackRecipient) : null;
  }

  // ---------------- StateSource ----------------

  accounts(): PublicKey[] {
    const keys = [this.pool, GLOBAL_CONFIG, FEE_CONFIG, this.mint, WSOL];
    const p = this.poolState;
    if (p) keys.push(p.poolBaseTokenAccount, p.poolQuoteTokenAccount);
    if (this.buybackAta) keys.push(this.buybackAta);
    else keys.push(...this.buybackCandidates);
    return keys;
  }

  /** Returns true if the raw bytes of `k` changed (and records them). */
  private changed(k: PublicKey, a: AccountInfo<Buffer>): boolean {
    const s = this.s(k);
    const old = this.raw.get(s);
    if (old && old.equals(a.data)) return false;
    this.raw.set(s, Buffer.from(a.data));
    return true;
  }

  /** base58 of keys used on every update (encoding costs a few µs each) */
  private b58 = new WeakMap<PublicKey, string>();
  private s(k: PublicKey): string {
    let v = this.b58.get(k);
    if (v === undefined) this.b58.set(k, (v = k.toBase58()));
    return v;
  }

  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    const get = (k: PublicKey) => infos.get(this.s(k)) ?? null;
    const pa = get(this.pool);
    if (!pa) throw new Error(`${this.name}: pool account missing from snapshot`);
    if (!pa.owner.equals(PumpSwapPool.PROGRAM) && !pa.owner.equals(PublicKey.default)) throw new Error(`${this.name}: pool not owned by pump_amm`);
    let changed = false;
    if (this.changed(this.pool, pa) || !this.poolState) {
      const p = decodePool(pa.data);
      if (!p.baseMint.equals(this.mint) || !p.quoteMint.equals(WSOL)) throw new Error(`${this.name}: unexpected pool mints ${p.baseMint.toBase58()}/${p.quoteMint.toBase58()}`);
      this.poolState = p;
      this.isPumpPool = pumpPoolAuthorityPda(p.baseMint).equals(p.creator);
      changed = true;
    }
    const g = get(GLOBAL_CONFIG);
    if (g && (this.changed(GLOBAL_CONFIG, g) || !this.global)) {
      this.global = decodeGlobalConfig(g.data);
      changed = true;
      const recips = this.buybackOverride ? [this.buybackOverride] : this.global.buybackFeeRecipients.filter((k) => !k.equals(PublicKey.default));
      const qp = this.quoteTokenProgram ?? TOKEN_PROGRAM;
      this.buybackCandidates = recips.map((r) => ata(r, WSOL, qp));
      if (this.buybackAta && !this.buybackCandidates.some((k) => k.equals(this.buybackAta!))) this.buybackAta = null;
    }
    const f = get(FEE_CONFIG);
    if (f && (this.changed(FEE_CONFIG, f) || !this.feeConfig)) {
      this.feeConfig = decodeFeeConfig(f.data);
      changed = true;
    }
    const m = get(this.mint);
    if (m && (this.changed(this.mint, m) || !this.baseMintInfo)) {
      this.baseMintInfo = decodeMint(m.data);
      this.baseSupply = mintSupply(m.data);
      this.baseTokenProgram = PumpSwapPool.tokenProgramOf(m.owner);
      changed = true;
    }
    const qm = get(WSOL);
    if (qm) this.quoteTokenProgram = PumpSwapPool.tokenProgramOf(qm.owner);
    const p = this.poolState!;
    const bv = get(p.poolBaseTokenAccount);
    const qv = get(p.poolQuoteTokenAccount);
    if (bv && this.changed(p.poolBaseTokenAccount, bv)) {
      this.baseReserve = tokenAmount(bv.data);
      changed = true;
    }
    if (qv && this.changed(p.poolQuoteTokenAccount, qv)) {
      this.quoteVault = tokenAmount(qv.data);
      changed = true;
    }
    // buyback recipient ATA: pick the first candidate that exists, then keep fetching only that one
    if (this.buybackAta) {
      if (infos.has(this.s(this.buybackAta)) && !get(this.buybackAta)) this.buybackAta = null;
    } else {
      this.buybackAta = this.buybackCandidates.find((k) => !!get(k)) ?? null;
    }
    this.slot = slot;
    if (changed) this.stateVersion++;
  }

  static readonly PROGRAM = PUMP_AMM_PROGRAM;

  private static tokenProgramOf(owner: PublicKey): PublicKey {
    if (owner.equals(TOKEN_PROGRAM)) return TOKEN_PROGRAM;
    if (owner.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
    throw new Error(`mint owned by unexpected program ${owner.toBase58()}`);
  }

  quoteKey(): string {
    return `${this.name}:${this.stateVersion}`;
  }

  /** True once every account needed for quoting and building ixs has been seen. */
  ready(): boolean {
    return !!this.poolState && !!this.global && !!this.baseMintInfo && !!this.quoteTokenProgram && this.baseReserve > 0n && this.quoteVault > 0n && !!this.buybackAta;
  }

  /** Quote reserve used by the curve: vault balance (fee buckets included) + virtual reserves. */
  quoteReserve(): bigint {
    return this.quoteVault + (this.poolState?.virtualQuoteReserves ?? 0n);
  }

  /** Fee bps that apply to a trade against the current (pre-trade) reserves. */
  currentFees(): Fees | null {
    const p = this.poolState;
    if (!p || !this.global) return null;
    const ctx: FeeContext = { global: this.global, feeConfig: this.feeConfig, pool: p, isPumpPool: this.isPumpPool, baseSupply: this.baseSupply };
    return computeFees(ctx, this.baseReserve, this.quoteReserve());
  }

  /** Marginal price, lamports per base unit (before fees). */
  spotPrice(): number {
    return Number(this.quoteReserve()) / Number(this.baseReserve);
  }

  private tradable(side: SwapSide): boolean {
    const p = this.poolState;
    const g = this.global;
    if (!p || !g || !this.baseMintInfo || this.baseReserve <= 0n || this.quoteReserve() <= 0n) return false;
    if (g.disableFlags & (side === "buy" ? DISABLE_BUY : DISABLE_SELL)) return false;
    if (p.isCashbackCoin) return false; // v2 trades reject cashback coins (they trade through v1)
    if (p.isHolderReward) return false; // not observed / not validated
    const mi = this.baseMintInfo;
    if (mi.transferHookProgram) return false;
    if (mi.transferFee && (mi.transferFee.older.basisPoints !== 0 || mi.transferFee.newer.basisPoints !== 0)) return false; // not modelled
    return true;
  }

  quoteExactIn(side: SwapSide, amountIn: bigint): SwapQuote | null {
    if (amountIn <= 0n || amountIn > U64_MAX || !this.tradable(side)) return null;
    const p = this.poolState!;
    const fees = this.currentFees()!;
    const Q = this.quoteReserve();
    if (side === "buy") {
      const r = buyExactQuoteIn(amountIn, this.baseReserve, Q, fees, this.global!.buybackBps, p.isMayhemMode);
      return r && { out: r.baseOut, netIn: r.debit, ctx: { side, r } satisfies PumpSwapQuoteCtx };
    }
    const real = this.quoteVault - p.protocolFees - p.creatorFees;
    const r = sellExactBaseIn(amountIn, this.baseReserve, Q, real, fees, this.global!.buybackBps, p.isMayhemMode);
    return r && { out: r.quoteOut, netIn: amountIn, ctx: { side, r } satisfies PumpSwapQuoteCtx };
  }

  /**
   * Advance cached state as if the quoted trade executed now (for quoting a second trade on this
   * pool in the same tx). trade_v2 bookkeeping, verified against simulated post-state:
   *   buy : base vault -= out; quote vault += debit - buyback
   *   sell: base vault += in;  quote vault -= out + buyback
   *   both: buckets += (protocol - buyback, creator) and virtual_quote_reserves -= the same amount,
   *         so the curve's effective quote reserve only moves by net+lp (buy) / gross-lp (sell).
   * (virtual + protocol_fees + creator_fees is constant across trades.)
   */
  applyQuote(q: SwapQuote): void {
    const c = q.ctx as PumpSwapQuoteCtx;
    const p = this.poolState!;
    const kept = c.r.protocolFee - c.r.buybackFee;
    if (c.side === "buy") {
      this.baseReserve -= c.r.baseOut;
      this.quoteVault += c.r.vaultIn;
    } else {
      this.baseReserve += q.netIn;
      this.quoteVault -= c.r.vaultOut;
    }
    this.poolState = {
      ...p,
      protocolFees: p.protocolFees + kept,
      creatorFees: p.creatorFees + c.r.coinCreatorFee,
      virtualQuoteReserves: p.virtualQuoteReserves - kept - c.r.coinCreatorFee,
    };
    this.stateVersion++;
  }

  // ---------------- instructions ----------------

  userAccounts(user: PublicKey) {
    const k = user.toBase58();
    let u = this.userCache.get(k);
    if (!u) {
      if (!this.baseTokenProgram || !this.quoteTokenProgram) throw new Error(`${this.name}: no state yet`);
      u = { base: ata(user, this.mint, this.baseTokenProgram), quote: ata(user, WSOL, this.quoteTokenProgram), uva: userVolumeAccumulatorPda(user) };
      this.userCache.set(k, u);
    }
    return u;
  }

  /** The 17 accounts of buy_exact_quote_in_v2 / sell_v2 (identical lists). */
  tradeV2Keys(user: PublicKey) {
    const p = this.poolState;
    if (!p || !this.buybackAta || !this.baseTokenProgram || !this.quoteTokenProgram) throw new Error(`${this.name}: not ready (pool/buyback recipient ATA/mint programs unknown)`);
    const u = this.userAccounts(user);
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    return [
      w(this.pool),
      { pubkey: user, isSigner: true, isWritable: true },
      r(GLOBAL_CONFIG),
      r(p.baseMint),
      r(p.quoteMint),
      w(u.base),
      w(u.quote),
      w(p.poolBaseTokenAccount),
      w(p.poolQuoteTokenAccount),
      r(this.baseTokenProgram),
      r(this.quoteTokenProgram),
      r(SYSTEM_PROGRAM),
      w(u.uva),
      r(FEE_CONFIG),
      w(this.buybackAta),
      r(EVENT_AUTHORITY),
      r(PUMP_AMM_PROGRAM),
    ];
  }

  swapIx(user: PublicKey, side: SwapSide, amountIn: bigint, minOut: bigint): TransactionInstruction {
    const d = Buffer.alloc(24);
    (side === "buy" ? BUY_EXACT_QUOTE_IN_V2_DISC : SELL_V2_DISC).copy(d, 0);
    d.writeBigUInt64LE(amountIn, 8);
    // buy_exact_quote_in_v2 requires a nonzero min_base_amount_out
    d.writeBigUInt64LE(side === "buy" && minOut < 1n ? 1n : minOut, 16);
    return new TransactionInstruction({ programId: PUMP_AMM_PROGRAM, keys: this.tradeV2Keys(user), data: d });
  }

  swapExactInIxs(user: PublicKey, side: SwapSide, amountIn: bigint, minOut: bigint, _q: SwapQuote): TransactionInstruction[] {
    return [this.swapIx(user, side, amountIn, minOut)];
  }

  /**
   * Programs whose upgrade must halt trading here: pump_amm, the pump-fees program that owns the
   * FeeConfig every trade reads (fee tiers), and both token programs a v2 trade CPIs into.
   */
  programIds(): PublicKey[] {
    return [PUMP_AMM_PROGRAM, PUMP_FEE_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
  }
}

export default PumpSwapPool;
