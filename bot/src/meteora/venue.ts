// SwapVenue adapter over MeteoraDlmm for any token/wSOL DLMM pool (token may be X or Y).
//   buy  = SOL -> token (exact-in lamports), sell = token -> SOL (exact-in token units).
// netIn reflects the host-fee rebate (our host_fee_in is the user's own fee-token account): with
// fee-on-input (InputOnly, or OnlyY when Y is the input) the rebate reduces netIn; with the fee on
// the output side (OnlyY mode, X -> Y) the rebate lands in the user's output account, so it is added
// to `out`. The program's min_amount_out applies to the swap output excluding that rebate, so
// swapExactInIxs subtracts it from the caller's minOut (minOut is always "what the user receives").
import { AccountInfo, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { SwapQuote, SwapSide, SwapVenue } from "../types.js";
import { WSOL_MINT } from "../types.js";
import { ExactInQuote, MeteoraDlmm, MeteoraDlmmOptions, Side } from "./index.js";
import { PROGRAM } from "./pda.js";

const WSOL = new PublicKey(WSOL_MINT);

export interface DlmmSwapVenueOptions extends Omit<MeteoraDlmmOptions, "mintX" | "mintY"> {
  pool: PublicKey | string;
  tokenMint: PublicKey | string;
  /** Which side of the pool the token is on. Default "x" (true for every MAX/SOL and the RISE pool). */
  tokenSide?: "x" | "y";
}

export interface DlmmQuoteCtx {
  side: Side;
  q: ExactInQuote;
  /** Part of `out` that is the host-fee rebate to the output account (fee-on-output pools). */
  rebateInOut: bigint;
}

export class DlmmSwapVenue implements SwapVenue {
  readonly name: string;
  readonly tokenMint: string;
  readonly dlmm: MeteoraDlmm;
  readonly tokenIsX: boolean;

  constructor(opts: DlmmSwapVenueOptions) {
    const token = new PublicKey(opts.tokenMint);
    this.tokenIsX = (opts.tokenSide ?? "x") === "x";
    this.dlmm = new MeteoraDlmm({
      ...opts,
      mintX: this.tokenIsX ? token : WSOL,
      mintY: this.tokenIsX ? WSOL : token,
    });
    this.tokenMint = token.toBase58();
    this.name = `dlmm:${this.dlmm.pool.toBase58()}`;
  }

  /** buy (SOL -> token) / sell (token -> SOL) -> internal X/Y side. */
  sideOf(side: SwapSide): Side {
    // token = X: buying it is Y -> X ("buyRise"); token = Y: buying it is X -> Y ("sellRise")
    return (side === "buy") === this.tokenIsX ? "buyRise" : "sellRise";
  }

  accounts(): PublicKey[] {
    return this.dlmm.accounts();
  }

  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    this.dlmm.update(slot, infos);
  }

  quoteKey(): string {
    return `${this.name}:${this.dlmm.quoteKey()}`;
  }

  ready(): boolean {
    return this.dlmm.ready();
  }

  quoteExactIn(side: SwapSide, amountIn: bigint): SwapQuote | null {
    const s = this.sideOf(side);
    const q = this.dlmm.quoteExactIn(s, amountIn);
    if (!q) return null;
    const rebateInOut = this.dlmm.opts.hostFeeRebate && !this.dlmm.feeIsOnInput(s) ? q.hostFee : 0n;
    const ctx: DlmmQuoteCtx = { side: s, q, rebateInOut };
    return { out: q.out + rebateInOut, netIn: q.netIn, ctx };
  }

  swapExactInIxs(user: PublicKey, side: SwapSide, amountIn: bigint, minOut: bigint, q: SwapQuote): TransactionInstruction[] {
    const c = q.ctx as DlmmQuoteCtx | undefined;
    if (!c?.q?.binArrays) throw new Error(`${this.name}: quote ctx missing (pass the SwapQuote from quoteExactIn)`);
    const s = this.sideOf(side);
    const programMin = minOut > c.rebateInOut ? minOut - c.rebateInOut : 0n;
    return [this.dlmm.swapExactInIx(user, s, amountIn, programMin, c.q.binArrays)];
  }

  programIds(): PublicKey[] {
    return [PROGRAM];
  }
}

export default DlmmSwapVenue;
