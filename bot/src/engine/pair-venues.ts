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
import { createSelectedMaxVenues, selectedMaxDlmmPools, MAX_DLMM_POOLS as REGISTRY } from "../pumpswap/pools.js";
import { EVENT_AUTHORITY, PUMP_AMM_PROGRAM, userVolumeAccumulatorPda } from "../pumpswap/pda.js";
import { DlmmSwapVenue, type DlmmQuoteCtx } from "../meteora/venue.js";
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

/** Attach the rebate hook (pair-optimizer.ts) to a DLMM venue: only the at-risk part of a SOL rebate pads the min-out. */
export function withRebateHook(dlmm: DlmmSwapVenue): DlmmSwapVenue {
  (dlmm as DlmmSwapVenue & { rebateAtRisk?: (side: "buy" | "sell", amountIn: bigint, q: SwapQuote) => bigint }).rebateAtRisk = (_side, _amt, q) => dlmmRebateAtRisk(dlmm, q);
  return dlmm;
}

/** pump_amm init_user_volume_accumulator (Anchor discriminator of "global:init_user_volume_accumulator"). */
export const INIT_UVA_DISC = createHash("sha256").update("global:init_user_volume_accumulator").digest().subarray(0, 8);

/**
 * Setup-only instruction creating the user's PumpSwap user_volume_accumulator (rent ≈ 1.35M lamports,
 * measured in simulation 2026-11-12). PumpSwap buys create it on first use otherwise; the engine refuses
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
export function maxShredWatch(dlmmPools: readonly string[] = selectedMaxDlmmPools()): PairWatch {
  return {
    name: "max",
    pools: [
      { name: "pumpswap", accounts: [MAX_PUMPSWAP_POOL] },
      ...dlmmPools.map((p) => ({ name: routeName(p), accounts: [p, dlmmReserve(p, MAX_MINT), dlmmReserve(p, "So11111111111111111111111111111111111111112")] })),
    ],
  };
}
