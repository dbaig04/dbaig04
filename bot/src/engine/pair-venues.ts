// Pair definitions (PAIRS=max) and venue factory for the generic pair engine.
// MAX = "Max coin" 5qaP7o…pump (Token-2022, 6 decimals, no transfer-fee / hook extensions:
// metadataPointer + tokenMetadata only, checked on-chain 2026-11-12).
// Pools (both verified from the research sample: every PumpSwap<->DLMM MAX arb seen touched these):
//   PumpSwap  Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ  (canonical pump pool, MAX/wSOL)
//   DLMM      H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ   (MAX = token X, wSOL = token Y)
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { MAX_MINT, type SwapQuote } from "../types.js";
import { createHash } from "node:crypto";
import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { PumpSwapPool } from "../pumpswap/index.js";
import { createSelectedMaxVenues, selectedMaxDlmmPools, selectedMaxPumpSwapPool, MAX_DLMM_POOLS as REGISTRY } from "../pumpswap/pools.js";
import { EVENT_AUTHORITY, PUMP_AMM_PROGRAM, userVolumeAccumulatorPda } from "../pumpswap/pda.js";
import { DlmmSwapVenue, type DlmmQuoteCtx } from "../meteora/venue.js";
import { BASIS_POINT_MAX, FEE_PRECISION, HOST_FEE_BPS } from "../meteora/math.js";
import type { PairSpec } from "./pair-engine.js";
import type { PairWatch } from "../feeds/shreds.js";
import { dlmmReserve } from "../feeds/shreds.js";

export const MAX_PUMPSWAP_POOL = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";
export const MAX_DLMM_POOL = "H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ";
/** The validated MAX/wSOL DLMM pools (src/pumpswap/pools.ts registry, deepest first; MAX = token X in all). */
export const MAX_DLMM_POOLS: readonly string[] = REGISTRY.map((p) => p.address);
export const routeName = (dlmmPool: string) => `max:${dlmmPool.slice(0, 6)}`;
/** Wallet simulated as for MAX when no keypair is given (the research wallet: holds wSOL + MAX ATAs). */
export const MAX_SIM_USER = "8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w";

/**
 * Part of a DLMM SOL-input host-fee rebate that is not guaranteed at landing: if every bin's fee
 * rate fell to the base rate the rebate shrinks by up to host·(last − base)/last (same rule as the
 * RISE optimizer), + 1 lamport per bin array crossed of rounding, + 2. A fee-on-output (OnlyY sell)
 * rebate folded into `out` is handled by dlmmOutputRebateAtRisk (side "sell"); a sell's token rebate is 0.
 */
export function dlmmRebateAtRisk(v: DlmmSwapVenue, q: SwapQuote, side: "buy" | "sell" = "buy", minOutLowerBound = 0n): bigint {
  const c = q.ctx as DlmmQuoteCtx | undefined;
  if (!c) return 0n;
  if (c.rebateInOut > 0n) return dlmmOutputRebateAtRisk(v, c, minOutLowerBound);
  // a sell's fee-on-input host rebate is paid in the token (residual), not SOL
  if (side === "sell") return 0n;
  const host = c.q.hostFee;
  if (host <= 0n) return 0n;
  const slack = BigInt(c.q.binArrays.length) + 2n;
  const base = v.dlmm.baseFeeRate();
  const last = c.q.lastFeeRate;
  if (base === null || last <= 0n) return host + slack;
  if (last <= base) return slack;
  return (host * (last - base) + last - 1n) / last + slack;
}

/**
 * Fee-on-output pools (OnlyY, X -> Y sell): `out` = swap output + host-fee rebate, and the venue
 * lowers the program's min_amount_out by the QUOTED rebate (venue.ts), because min_amount_out applies
 * to the swap output only. At landing the rebate scales with the gross output actually paid and the
 * fee rate then, so a landing that pays exactly the program min-out (price moved against us) returns
 * a smaller rebate than quoted and the user would receive less than the caller's min-out.
 * Guaranteed part: any landing with swap output >= P pays a total fee >= P·base/(1e9 − base) (every
 * bin's rate >= the base rate; fee = ceil(gross·rate/1e9)), hence a host fee
 * >= fee·share/1e4·20% − 3 lamports of per-bin flooring per bin (<= 70 bins per bin array passed).
 * P >= minOutLowerBound − quoted rebate. Returns quoted rebate − guaranteed part (>= 0).
 */
export function dlmmOutputRebateAtRisk(v: DlmmSwapVenue, c: DlmmQuoteCtx, minOutLowerBound: bigint): bigint {
  const reb = c.rebateInOut;
  const lb = v.dlmm.lbPair;
  const base = v.dlmm.baseFeeRate();
  if (!lb || base === null || base <= 0n || base >= FEE_PRECISION) return reb;
  const p = minOutLowerBound - reb;
  if (p <= 0n) return reb;
  const g = (p * base * BigInt(lb.s.protocolShare) * HOST_FEE_BPS) / ((FEE_PRECISION - base) * BASIS_POINT_MAX * BASIS_POINT_MAX) - 3n * 70n * BigInt(c.q.binArrays.length);
  if (g <= 0n) return reb;
  return g >= reb ? 0n : reb - g;
}

/** Attach the rebate hook (pair-optimizer.ts) to a DLMM venue: only the at-risk part of a SOL rebate pads the min-out. */
export function withRebateHook(dlmm: DlmmSwapVenue): DlmmSwapVenue {
  (dlmm as DlmmSwapVenue & { rebateAtRisk?: (side: "buy" | "sell", amountIn: bigint, q: SwapQuote, minOutLowerBound?: bigint) => bigint }).rebateAtRisk = (side, _amt, q, lower) => dlmmRebateAtRisk(dlmm, q, side, lower ?? 0n);
  return dlmm;
}

/** pump_amm init_user_volume_accumulator (Anchor discriminator of "global:init_user_volume_accumulator"). */
export const INIT_UVA_DISC = createHash("sha256").update("global:init_user_volume_accumulator").digest().subarray(0, 8);

/**
 * Setup-only instruction creating the user's PumpSwap user_volume_accumulator (rent 1,844,400 lamports for the 137-byte account,
 * checked on-chain 2026-11-12). PumpSwap buys create it on first use otherwise; the engine refuses
 * to trade until it exists, so that rent never lands in a trade tx. Accounts: payer, user, uva, system,
 * event authority, program (simulated OK on mainnet for a wallet without one).
 */
export function initUserVolumeAccumulatorIx(user: PublicKey, payer: PublicKey = user): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM, data: Buffer.from(INIT_UVA_DISC),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulatorPda(user), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false }, { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
}

/** Venue hook read by PairEngine: user accounts that must exist before the venue may be traded. */
export function withUserPrereqs(p: PumpSwapPool): PumpSwapPool {
  (p as PumpSwapPool & { requiredUserAccounts?: (u: PublicKey) => { account: PublicKey; why: string }[] }).requiredUserAccounts = (u) => [{ account: userVolumeAccumulatorPda(u), why: "PumpSwap user_volume_accumulator (create with setup: PAIRS=max npx tsx src/engine/setup.ts)" }];
  return p;
}

export function createMaxVenues(dlmmPool: string = MAX_DLMM_POOL): { pumpswap: PumpSwapPool; dlmm: DlmmSwapVenue } {
  const v = createSelectedMaxVenues({ ...process.env, MAX_DLMM_POOLS: dlmmPool });
  return { pumpswap: withUserPrereqs(v.pumpswap), dlmm: withRebateHook(v.dlmm[0]) };
}

/**
 * MAX pair: one shared PumpSwap venue vs each selected DLMM pool (src/pumpswap/pools.ts:
 * MAX_PUMPSWAP_POOL, MAX_DLMM_POOLS / MAX_DLMM_POOL, default all three deepest first). The PumpSwap
 * object is shared, so its state is fetched and decoded once per tick.
 */
export function maxPairSpec(env: NodeJS.ProcessEnv = process.env): PairSpec & { pumpswap: PumpSwapPool; dlmmVenues: DlmmSwapVenue[] } {
  const v = createSelectedMaxVenues(env);
  const pumpswap = withUserPrereqs(v.pumpswap);
  const dlmmVenues = v.dlmm.map(withRebateHook);
  const routes = dlmmVenues.map((b) => ({ name: routeName(b.dlmm.pool.toBase58()), a: pumpswap, b }));
  return { name: "max", a: pumpswap, b: dlmmVenues[0], routes, tokenMint: new PublicKey(MAX_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID, pumpswap, dlmmVenues };
}

/** Selected DLMM pool addresses (pools.ts env selection). */
export const selectedDlmmPools = (env: NodeJS.ProcessEnv = process.env) => selectedMaxDlmmPools(env);

/** Shred watch entry for the MAX pair: pool addresses (+ DLMM reserves). */
export function maxShredWatch(dlmmPools: readonly string[] = selectedMaxDlmmPools(), pumpPool: string = selectedMaxPumpSwapPool()): PairWatch {
  return {
    name: "max",
    pools: [
      { name: "pumpswap", accounts: [pumpPool] },
      ...dlmmPools.map((p) => ({ name: routeName(p), accounts: [p, dlmmReserve(p, MAX_MINT), dlmmReserve(p, "So11111111111111111111111111111111111111112")] })),
    ],
  };
}
