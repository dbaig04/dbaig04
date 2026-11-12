// Exact PumpSwap (pump_amm) v2-trade math in bigint. Ported from @pump-fun/pump-swap-sdk 2.2.0
// (src/sdk/fees.ts, buy.ts exactQuoteInFees, sell.ts sellAmounts, multiHop.ts poolHopAmountOut,
// util.ts) and checked against on-chain events and mainnet simulation (see NOTES.md).
//
// Conventions: base = the pool's base mint (MAX), quote = wSOL. Q = quote vault balance (fee
// buckets included) + pool.virtualQuoteReserves, B = base vault balance.
import { PublicKey } from "@solana/web3.js";
import type { FeeConfigState, FeeTier, Fees, GlobalConfigState, PoolState } from "./layout.js";

export const BPS = 10_000n;
/** pump-amm TOTAL_TOKEN_SUPPLY: market-cap basis of mayhem-mode pools. */
export const PUMP_AMM_TOTAL_TOKEN_SUPPLY = 1_000_000_000_000_000n;

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const NATIVE_MINT_2022 = new PublicKey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Fee = ceil(amount * bps / 10000) (pump-amm `fee`). */
export const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

export function isSolLikeQuoteMint(m: PublicKey): boolean {
  return m.equals(PublicKey.default) || m.equals(NATIVE_MINT) || m.equals(NATIVE_MINT_2022);
}

/** pump-fees-math calculate_fee_tier: the last tier whose threshold <= mcap (first tier below all). */
export function calculateFeeTier(tiers: FeeTier[], marketCap: bigint): Fees {
  if (tiers.length === 0) throw new Error("Fee tiers cannot be empty.");
  if (marketCap < tiers[0].marketCapLamportsThreshold) return tiers[0].fees;
  for (let i = tiers.length - 1; i >= 0; i--) if (marketCap >= tiers[i].marketCapLamportsThreshold) return tiers[i].fees;
  return tiers[0].fees;
}

/** Pool::market_cap: quote reserve (incl. virtual) * circulating supply / base reserve (floor). */
export function poolMarketCap(baseSupply: bigint, baseReserve: bigint, quoteReserve: bigint, isMayhemMode: boolean): bigint {
  if (baseReserve === 0n) throw new Error("pool base reserve is zero");
  return (quoteReserve * (isMayhemMode ? PUMP_AMM_TOTAL_TOKEN_SUPPLY : baseSupply)) / baseReserve;
}

export interface FeeContext {
  global: GlobalConfigState;
  feeConfig: FeeConfigState | null;
  pool: PoolState;
  /** true when pool.creator is the pump program's pool-authority PDA of the base mint (canonical pump pool) */
  isPumpPool: boolean;
  baseSupply: bigint;
}

/**
 * pump-amm compute_fees (SDK computeFeesBps): fee schedule by pool creator + quote mint, tiered by
 * market cap computed from the PRE-trade reserves. A configured per-pool creator rate replaces the
 * schedule's creator rate while globalConfig.creatorFeeConfigurable is on. No coin creator => 0.
 */
export function computeFees(c: FeeContext, baseReserve: bigint, quoteReserve: bigint): Fees {
  let f: Fees;
  if (c.feeConfig) {
    const fc = c.feeConfig;
    if (!c.isPumpPool) f = fc.flatFees;
    else if (isSolLikeQuoteMint(c.pool.quoteMint)) f = calculateFeeTier(fc.feeTiers, poolMarketCap(c.baseSupply, baseReserve, quoteReserve, c.pool.isMayhemMode));
    else if (c.pool.quoteMint.equals(USDC_MINT))
      f = calculateFeeTier(fc.stableFeeTiers.length ? fc.stableFeeTiers : fc.feeTiers, poolMarketCap(c.baseSupply, baseReserve, quoteReserve, c.pool.isMayhemMode));
    else {
      const e = fc.exoticFlatFees;
      f = e.lpFeeBps === 0n && e.protocolFeeBps === 0n && e.creatorFeeBps === 0n ? fc.flatFees : e;
    }
    if (c.global.creatorFeeConfigurable && c.pool.creatorFeeBps > 0n) f = { ...f, creatorFeeBps: c.pool.creatorFeeBps };
  } else {
    f = { lpFeeBps: c.global.lpFeeBps, protocolFeeBps: c.global.protocolFeeBps, creatorFeeBps: c.global.coinCreatorFeeBps };
  }
  if (c.pool.coinCreator.equals(PublicKey.default)) f = { ...f, creatorFeeBps: 0n };
  return f;
}

export interface BuyResult {
  /** base tokens sent to the user */
  baseOut: bigint;
  /** quote that prices the swap (event user_quote_amount_in) */
  netQuote: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  coinCreatorFee: bigint;
  /** part of the protocol fee paid out to the buyback recipient (rest stays in the vault bucket) */
  buybackFee: bigint;
  /** decrease of the user's quote balance */
  debit: bigint;
  /** increase of the quote vault */
  vaultIn: bigint;
  fees: Fees;
}

/**
 * buy_exact_quote_in_v2(spendable_quote_in): trade_v2 exact_quote_in_fees + the constant-product
 * fill. net = floor(s*1e4/(1e4+total_bps)); fees = ceil(net*bps/1e4) each; if net+fees > s, net
 * is shaved by the excess (fees stay as computed). base_out = floor(B*(net-1)/(Q+net-1)).
 * Returns null where the program would reject (no budget left after fees, zero output).
 */
export function buyExactQuoteIn(spendable: bigint, baseReserve: bigint, quoteReserve: bigint, fees: Fees, buybackBps: bigint, isMayhemMode: boolean): BuyResult | null {
  if (spendable <= 0n || baseReserve <= 0n || quoteReserve <= 0n) return null;
  const total = fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps;
  let net = (spendable * BPS) / (total + BPS);
  if (net <= 0n) return null;
  const lpFee = feeOf(net, fees.lpFeeBps);
  const protocolFee = feeOf(net, fees.protocolFeeBps);
  const coinCreatorFee = feeOf(net, fees.creatorFeeBps);
  const excess = net + lpFee + protocolFee + coinCreatorFee - spendable;
  if (excess > 0n) net -= excess;
  if (net <= 1n) return null;
  const input = net - 1n;
  const baseOut = (baseReserve * input) / (quoteReserve + input);
  if (baseOut <= 0n || baseOut >= baseReserve) return null;
  const buybackFee = isMayhemMode ? 0n : (protocolFee * buybackBps) / BPS;
  const debit = net + lpFee + protocolFee + coinCreatorFee;
  return { baseOut, netQuote: net, lpFee, protocolFee, coinCreatorFee, buybackFee, debit, vaultIn: debit - buybackFee, fees };
}

export interface SellResult {
  /** quote sent to the user */
  quoteOut: bigint;
  /** gross constant-product output (event quote_amount_out) */
  grossQuote: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  coinCreatorFee: bigint;
  buybackFee: bigint;
  /** decrease of the quote vault */
  vaultOut: bigint;
  fees: Fees;
}

/**
 * sell_v2(base_amount_in): gross = floor(Q*b/(B+b)); fees = ceil(gross*bps/1e4) each; the user gets
 * gross - lp - protocol - creator. The real (bucket-free) quote reserve must cover gross - lp.
 */
export function sellExactBaseIn(
  baseIn: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  realQuoteReserve: bigint,
  fees: Fees,
  buybackBps: bigint,
  isMayhemMode: boolean,
): SellResult | null {
  if (baseIn <= 0n || baseReserve <= 0n || quoteReserve <= 0n) return null;
  const grossQuote = (quoteReserve * baseIn) / (baseReserve + baseIn);
  const lpFee = feeOf(grossQuote, fees.lpFeeBps);
  const protocolFee = feeOf(grossQuote, fees.protocolFeeBps);
  const coinCreatorFee = feeOf(grossQuote, fees.creatorFeeBps);
  const withoutLp = grossQuote - lpFee;
  if (realQuoteReserve < withoutLp) return null;
  const quoteOut = withoutLp - protocolFee - coinCreatorFee;
  if (quoteOut <= 0n) return null;
  const buybackFee = isMayhemMode ? 0n : (protocolFee * buybackBps) / BPS;
  return { quoteOut, grossQuote, lpFee, protocolFee, coinCreatorFee, buybackFee, vaultOut: quoteOut + buybackFee, fees };
}
