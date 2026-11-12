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
/** The three MAX/wSOL DLMM pools traded against the PumpSwap pool (MAX = token X in all three, checked on-chain). */
export const MAX_DLMM_POOLS = ["5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ", "6PkALvWhf2PJ3VwPsezFJdmvQ684REGkr7vLBihkNkH", MAX_DLMM_POOL] as const;
export const routeName = (dlmmPool: string) => `max:${dlmmPool.slice(0, 6)}`;
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

export function createDlmmVenue(pool: string): DlmmSwapVenue {
  const dlmm = new DlmmSwapVenue({ pool, tokenMint: MAX_MINT, tokenSide: "x" });
  // pair-optimizer.ts rebate hook: only the at-risk part of the DLMM SOL rebate pads the min-out
  (dlmm as DlmmSwapVenue & { rebateAtRisk?: (side: "buy" | "sell", amountIn: bigint, q: SwapQuote) => bigint }).rebateAtRisk = (_side, _amt, q) => dlmmRebateAtRisk(dlmm, q);
  return dlmm;
}

export function createMaxVenues(dlmmPool: string = MAX_DLMM_POOL): { pumpswap: PumpSwapPool; dlmm: DlmmSwapVenue } {
  return { pumpswap: new PumpSwapPool({ pool: MAX_PUMPSWAP_POOL, tokenMint: MAX_MINT }), dlmm: createDlmmVenue(dlmmPool) };
}

/**
 * MAX pair: one shared PumpSwap venue vs each DLMM pool (MAX_DLMM_ROUTES / default all three).
 * The PumpSwap object is shared, so its state is fetched and decoded once per tick.
 */
export function maxPairSpec(dlmmPools: readonly string[] = MAX_DLMM_POOLS): PairSpec & { pumpswap: PumpSwapPool; dlmmVenues: DlmmSwapVenue[] } {
  const pumpswap = new PumpSwapPool({ pool: MAX_PUMPSWAP_POOL, tokenMint: MAX_MINT });
  const dlmmVenues = dlmmPools.map(createDlmmVenue);
  const routes = dlmmVenues.map((b, i) => ({ name: routeName(dlmmPools[i]), a: pumpswap, b }));
  return { name: "max", a: pumpswap, b: dlmmVenues[0], routes, tokenMint: new PublicKey(MAX_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID, pumpswap, dlmmVenues };
}

/** Shred watch entry for the MAX pair: pool addresses (+ DLMM reserves). */
export function maxShredWatch(dlmmPools: readonly string[] = MAX_DLMM_POOLS): PairWatch {
  return {
    name: "max",
    pools: [
      { name: "pumpswap", accounts: [MAX_PUMPSWAP_POOL] },
      ...dlmmPools.map((p) => ({ name: routeName(p), accounts: [p, dlmmReserve(p, MAX_MINT), dlmmReserve(p, "So11111111111111111111111111111111111111112")] })),
    ],
  };
}
