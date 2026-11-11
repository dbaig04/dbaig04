// Shared interfaces between modules. All amounts are raw base units (bigint):
// SOL in lamports, RISE in token base units. Owners of each module must keep
// these signatures stable; change them only in coordination.
import type { PublicKey, TransactionInstruction, AccountInfo, Connection } from "@solana/web3.js";

export const RISE_PROGRAM_ID = "RiseP9yY3UnMxd1df7mgGJiR39frg9QGsr1ro3zxrDq";
export const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const POOL_ADDRESS = "4xjgBHDdLJcHYyWsL7pLCpUR556qVJyizLQ4qPVgrapt";
export const RISE_MINT = "EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Accounts a module needs refreshed each tick. Engine batches them via getMultipleAccountsInfo. */
export interface StateSource {
  /** Accounts to fetch (static set, may grow after first refresh, e.g. bin arrays). */
  accounts(): PublicKey[];
  /** Ingest a fresh snapshot (same slot for all accounts). */
  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void;
}

/** Native RISE mint/redeem venue. */
export interface RiseVenue extends StateSource {
  /** Exact lamports-in -> RISE-out the program's Buy would produce now (after its fees). null if disallowed. */
  quoteBuy(lamportsIn: bigint): bigint | null;
  /** Exact RISE-in -> lamports-out the program's Sell would produce now (after its fees). */
  quoteSell(riseIn: bigint): bigint | null;
  buyIx(user: PublicKey, lamportsIn: bigint, minRiseOut: bigint): TransactionInstruction;
  sellIx(user: PublicKey, riseIn: bigint, minLamportsOut: bigint): TransactionInstruction;
}

/** Meteora DLMM RISE/SOL pool. */
export interface DlmmVenue extends StateSource {
  /** Exact-in: amount of output token received (net of LP/protocol fees and Token-2022 transfer fees). */
  quoteExactIn(side: "sellRise" | "buyRise", amountIn: bigint): { out: bigint; binArrays: PublicKey[] } | null;
  /** Exact-out: input required to receive exactly amountOut. */
  quoteExactOut(side: "sellRise" | "buyRise", amountOut: bigint): { inp: bigint; binArrays: PublicKey[] } | null;
  swapExactInIx(user: PublicKey, side: "sellRise" | "buyRise", amountIn: bigint, minOut: bigint, binArrays: PublicKey[]): TransactionInstruction;
  swapExactOutIx(user: PublicKey, side: "sellRise" | "buyRise", amountOut: bigint, maxIn: bigint, binArrays: PublicKey[]): TransactionInstruction;
}

export type Direction = "mintThenSell" | "buyThenRedeem";

export interface Opportunity {
  direction: Direction;
  slot: number;
  /** Lamports spent on leg 1 (mint) or on DLMM buy. */
  lamportsIn: bigint;
  /** RISE moved between legs. */
  rise: bigint;
  /** Lamports back at the end of leg 2. */
  lamportsOut: bigint;
  /** lamportsOut - lamportsIn - estimated tx cost. */
  expectedProfit: bigint;
  txCostLamports: bigint;
}
