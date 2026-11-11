// Bigint port of the DLMM swap math (fee model + per-bin fills, incl. limit-order liquidity),
// mirroring @meteora-ag/dlmm 1.9.14 helpers/fee.ts, helpers/bin.ts and DLMM.updateReference /
// updateVolatilityAccumulator, but driven by the on-chain Clock timestamp instead of Date.now().
// Verified to the base unit against mainnet simulateTransaction (see validate.ts / NOTES.md).
import type { Bin, StaticParams, VariableParams } from "./layout.js";

export const FEE_PRECISION = 1_000_000_000n;
export const MAX_FEE_RATE = 100_000_000n;
export const BASIS_POINT_MAX = 10_000n;
export const HOST_FEE_BPS = 2_000n;
export const LIMIT_ORDER_FEE_SHARE = 5_000n;
export const U64_MAX = (1n << 64n) - 1n;
const SCALE_OFFSET = 64n;

export interface MutVParams {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
}

/** DLMM.updateReference: once per swap, before the bin loop. */
export function updateReference(v: VariableParams, s: StaticParams, activeId: number, now: bigint): MutVParams {
  const out: MutVParams = {
    volatilityAccumulator: v.volatilityAccumulator,
    volatilityReference: v.volatilityReference,
    indexReference: v.indexReference,
  };
  const elapsed = now - v.lastUpdateTimestamp;
  if (elapsed >= BigInt(s.filterPeriod)) {
    out.indexReference = activeId;
    if (elapsed < BigInt(s.decayPeriod)) {
      out.volatilityReference = Math.floor((v.volatilityAccumulator * s.reductionFactor) / 10_000);
    } else {
      out.volatilityReference = 0;
    }
  }
  return out;
}

/** DLMM.updateVolatilityAccumulator: before swapping in each non-empty bin. */
export function updateVolatilityAccumulator(v: MutVParams, s: StaticParams, activeId: number): void {
  const delta = Math.abs(v.indexReference - activeId);
  v.volatilityAccumulator = Math.min(v.volatilityReference + delta * 10_000, s.maxVolatilityAccumulator);
}

export function baseFeeRate(binStep: number, s: StaticParams): bigint {
  return BigInt(s.baseFactor) * BigInt(binStep) * 10n * 10n ** BigInt(s.baseFeePowerFactor);
}

export function variableFeeRate(binStep: number, s: StaticParams, va: number): bigint {
  if (s.variableFeeControl <= 0) return 0n;
  const x = BigInt(va) * BigInt(binStep);
  return (BigInt(s.variableFeeControl) * x * x + 99_999_999_999n) / 100_000_000_000n;
}

export function totalFeeRate(binStep: number, s: StaticParams, va: number): bigint {
  const t = baseFeeRate(binStep, s) + variableFeeRate(binStep, s, va);
  return t > MAX_FEE_RATE ? MAX_FEE_RATE : t;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** fee = ceil(amount * rate / 1e9); returns amount - fee */
export function excludedFee(includedAmount: bigint, rate: bigint): { excluded: bigint; fee: bigint } {
  const fee = ceilDiv(includedAmount * rate, FEE_PRECISION);
  return { excluded: includedAmount - fee, fee };
}

/** included = ceil(amount * 1e9 / (1e9 - rate)) */
export function includedFee(excludedAmount: bigint, rate: bigint): { included: bigint; fee: bigint } {
  const included = ceilDiv(excludedAmount * FEE_PRECISION, FEE_PRECISION - rate);
  return { included, fee: included - excludedAmount };
}

/** Input needed (fee-excluded) to take `amountOut` from a bin at `price` (Q64.64, Y per X). */
export function amountInForOut(amountOut: bigint, price: bigint, swapForY: boolean, roundUp: boolean): bigint {
  if (swapForY) {
    // X in -> Y out: in = out << 64 / price
    const n = amountOut << SCALE_OFFSET;
    return roundUp ? ceilDiv(n, price) : n / price;
  }
  const n = amountOut * price;
  const q = n >> SCALE_OFFSET;
  return roundUp && (n & U64_MAX) !== 0n ? q + 1n : q;
}

/** Output for a fee-excluded input (rounded down). */
export function amountOutForIn(amountIn: bigint, price: bigint, swapForY: boolean): bigint {
  return swapForY ? (amountIn * price) >> SCALE_OFFSET : (amountIn << SCALE_OFFSET) / price;
}

export interface BinView {
  mm: bigint; // market-making liquidity of the output token
  processed: bigint; // processed limit-order remaining amount usable in this direction
  open: bigint; // open limit-order amount usable in this direction
  price: bigint;
}

export function binView(bin: Bin, swapForY: boolean, supportLimitOrder: boolean): BinView {
  const mm = swapForY ? bin.amountY : bin.amountX;
  // Limit orders on the bid side hold Y (filled by X->Y swaps); ask side hold X.
  const usable = supportLimitOrder && ((swapForY && !bin.limitOrderAskSide) || (!swapForY && bin.limitOrderAskSide));
  return {
    mm,
    processed: usable ? bin.processedOrderRemainingAmount : 0n,
    open: usable ? bin.openOrderAmount : 0n,
    price: bin.price,
  };
}

export const binMaxOut = (b: BinView) => b.mm + b.processed + b.open;

interface Fill {
  amountIn: bigint;
  amountLeft: bigint;
  out: bigint;
}

function fillTranche(amount: bigint, maxOut: bigint, price: bigint, swapForY: boolean): Fill {
  const maxIn = amountInForOut(maxOut, price, swapForY, true);
  if (amount >= maxIn) return { amountIn: maxIn, amountLeft: amount - maxIn, out: maxOut };
  return { amountIn: amount, amountLeft: 0n, out: amountOutForIn(amount, price, swapForY) };
}

export interface BinSwapResult {
  amountIn: bigint; // fee-inclusive input consumed by this bin
  amountOut: bigint; // fee-exclusive output delivered
  fee: bigint; // total trading fee
  protocolFee: bigint; // protocol share (before host split)
}

/** swapExactInQuoteAtBin */
export function swapExactInAtBin(b: BinView, rate: bigint, protocolShare: bigint, inAmount: bigint, swapForY: boolean, feeOnInput: boolean): BinSwapResult {
  let tradingFee = 0n;
  let exclIn = inAmount;
  if (feeOnInput) {
    const r = excludedFee(inAmount, rate);
    tradingFee = r.fee;
    exclIn = r.excluded;
  }
  // MM liquidity first, then processed orders, then open orders.
  const mmFill = fillTranche(exclIn, b.mm, b.price, swapForY);
  let totalIn = mmFill.amountIn;
  let totalOut = mmFill.out;
  let left = mmFill.amountLeft;
  if (left > 0n && (b.processed > 0n || b.open > 0n)) {
    const p = fillTranche(left, b.processed, b.price, swapForY);
    totalIn += p.amountIn;
    totalOut += p.out;
    left = p.amountLeft;
    if (left > 0n) {
      const o = fillTranche(left, b.open, b.price, swapForY);
      totalIn += o.amountIn;
      totalOut += o.out;
      left = o.amountLeft;
    }
  }
  let inclIn = inAmount;
  if (left > 0n) {
    exclIn -= left;
    if (feeOnInput) {
      const r = includedFee(exclIn, rate);
      tradingFee = r.fee;
      inclIn = r.included;
    } else {
      inclIn = exclIn;
    }
  }
  let exclOut = totalOut;
  if (!feeOnInput) {
    const r = excludedFee(totalOut, rate);
    tradingFee = r.fee;
    exclOut = r.excluded;
  }
  // splitFee
  let protocolFee = 0n;
  if (totalIn > 0n) {
    const mmFee = ceilDiv(tradingFee * mmFill.amountIn, totalIn);
    const totalLoFee = tradingFee - mmFee;
    const loFee = (totalLoFee * LIMIT_ORDER_FEE_SHARE) / BASIS_POINT_MAX;
    protocolFee = totalLoFee - loFee + (mmFee * protocolShare) / BASIS_POINT_MAX;
  } else {
    tradingFee = 0n;
  }
  return { amountIn: inclIn, amountOut: exclOut, fee: tradingFee, protocolFee };
}

/** swapExactOutQuoteAtBin */
export function swapExactOutAtBin(b: BinView, rate: bigint, protocolShare: bigint, outAmount: bigint, swapForY: boolean, feeOnInput: boolean): BinSwapResult {
  let inclOut = outAmount;
  if (!feeOnInput) inclOut = includedFee(outAmount, rate).included;
  if (inclOut >= binMaxOut(b)) return swapExactInAtBin(b, rate, protocolShare, U64_MAX, swapForY, feeOnInput);

  // fee-excluded input for the requested output, tranche by tranche (rounded up each)
  let remaining = inclOut;
  let exclIn = 0n;
  for (const cap of [b.mm, b.processed, b.open]) {
    if (remaining === 0n) break;
    const take = remaining < cap ? remaining : cap;
    exclIn += amountInForOut(take, b.price, swapForY, true);
    remaining -= take;
  }
  const inclIn = feeOnInput ? includedFee(exclIn, rate).included : exclIn;
  const r = swapExactInAtBin(b, rate, protocolShare, inclIn, swapForY, feeOnInput);
  // NOTE: the SDK adds (quotedOut - outAmount) to protocolFee here (mixing output-token units into an
  // input-token fee). The program does not: simulated host fees match only without it.
  return { amountIn: r.amountIn, amountOut: outAmount, fee: r.fee, protocolFee: r.protocolFee };
}

// ---- Token-2022 transfer fee (epoch-dependent) ----
import type { MintInfo } from "./layout.js";

function activeTransferFee(m: MintInfo, epoch: bigint) {
  if (!m.transferFee) return null;
  return epoch >= m.transferFee.newer.epoch ? m.transferFee.newer : m.transferFee.older;
}

/** amount that arrives after the transfer fee is withheld */
export function transferFeeExcluded(m: MintInfo | null, epoch: bigint, amount: bigint): bigint {
  const f = m && activeTransferFee(m, epoch);
  if (!f || f.basisPoints === 0 || amount === 0n) return amount;
  let fee = ceilDiv(amount * BigInt(f.basisPoints), 10_000n);
  if (fee > f.maximumFee) fee = f.maximumFee;
  return amount - fee;
}

/** gross amount to send so that `net` arrives (spl-token calculateInverseEpochFee semantics) */
export function transferFeeIncluded(m: MintInfo | null, epoch: bigint, net: bigint): bigint {
  const f = m && activeTransferFee(m, epoch);
  if (!f || f.basisPoints === 0 || net === 0n) return net;
  const bps = BigInt(f.basisPoints);
  if (bps === 10_000n) return net + f.maximumFee;
  const raw = ceilDiv(net * 10_000n, 10_000n - bps);
  const fee = raw - net;
  return fee > f.maximumFee ? net + f.maximumFee : raw;
}
