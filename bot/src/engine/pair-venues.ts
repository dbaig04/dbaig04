// Pair definitions (PAIRS=max) and venue factory for the generic pair engine.
// MAX = "Max coin" 5qaP7o…pump (Token-2022, 6 decimals, no transfer-fee / hook extensions:
// metadataPointer + tokenMetadata only, checked on-chain 2026-11-12).
// Pools (both verified from the research sample: every PumpSwap<->DLMM MAX arb seen touched these):
//   PumpSwap  Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ  (canonical pump pool, MAX/wSOL)
//   DLMM      H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ   (MAX = token X, wSOL = token Y)
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { MAX_MINT, type SwapQuote } from "../types.js";
import { PumpSwapPool } from "../pumpswap/index.js";
import { DlmmSwapVenue, type DlmmQuoteCtx } from "../meteora/venue.js";
import type { PairSpec } from "./pair-engine.js";
import type { PairWatch } from "../feeds/shreds.js";
import { dlmmReserve } from "../feeds/shreds.js";

export const MAX_PUMPSWAP_POOL = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";
export const MAX_DLMM_POOL = "H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ";
/** Wallet simulated as for MAX when no keypair is given (the research wallet: holds wSOL + MAX ATAs). */
export const MAX_SIM_USER = "8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w";

/**
 * Part of a DLMM SOL-input host-fee rebate that is not guaranteed at landing: if every bin's fee
 * rate fell to the base rate the rebate shrinks by up to host·(last − base)/last (same rule as the
 * RISE optimizer), + 1 lamport per bin array crossed of rounding, + 2.
 */
export function dlmmRebateAtRisk(v: DlmmSwapVenue, q: SwapQuote): bigint {
  const c = q.ctx as DlmmQuoteCtx | undefined;
  if (!c) return 0n;
  const host = c.q.hostFee;
  if (host <= 0n || c.rebateInOut > 0n) return 0n;
  const slack = BigInt(c.q.binArrays.length) + 2n;
  const base = v.dlmm.baseFeeRate();
  const last = c.q.lastFeeRate;
  if (base === null || last <= 0n) return host + slack;
  if (last <= base) return slack;
  return (host * (last - base) + last - 1n) / last + slack;
}

export function createMaxVenues(): { pumpswap: PumpSwapPool; dlmm: DlmmSwapVenue } {
  const pumpswap = new PumpSwapPool({ pool: MAX_PUMPSWAP_POOL, tokenMint: MAX_MINT });
  const dlmm = new DlmmSwapVenue({ pool: MAX_DLMM_POOL, tokenMint: MAX_MINT, tokenSide: "x" });
  // pair-optimizer.ts rebate hook: only the at-risk part of the DLMM SOL rebate pads the min-out
  (dlmm as DlmmSwapVenue & { rebateAtRisk?: (side: "buy" | "sell", amountIn: bigint, q: SwapQuote) => bigint }).rebateAtRisk = (_side, _amt, q) => dlmmRebateAtRisk(dlmm, q);
  return { pumpswap, dlmm };
}

export function maxPairSpec(): PairSpec & { pumpswap: PumpSwapPool; dlmmVenue: DlmmSwapVenue } {
  const { pumpswap, dlmm } = createMaxVenues();
  return { name: "max", a: pumpswap, b: dlmm, tokenMint: new PublicKey(MAX_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID, pumpswap, dlmmVenue: dlmm };
}

/** Shred watch entry for the MAX pair: pool addresses (+ DLMM reserves). */
export function maxShredWatch(): PairWatch {
  return {
    name: "max",
    pools: [
      { name: "pumpswap", accounts: [MAX_PUMPSWAP_POOL] },
      { name: "dlmm", accounts: [MAX_DLMM_POOL, dlmmReserve(MAX_DLMM_POOL, MAX_MINT), dlmmReserve(MAX_DLMM_POOL, "So11111111111111111111111111111111111111112")] },
    ],
  };
}
