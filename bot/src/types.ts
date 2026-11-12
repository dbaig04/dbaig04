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

// ---------------------------------------------------------------------------
// Generic two-pool token/SOL arbitrage (added for MAX: PumpSwap <-> Meteora DLMM).
// The RISE interfaces above stay as they are; new pairs use these.

export const MAX_MINT = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump"; // "Max coin", Token-2022, 6 decimals
export const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/** "buy" = SOL in -> token out, "sell" = token in -> SOL out. */
export type SwapSide = "buy" | "sell";

export interface SwapQuote {
  /** Amount received by the user (after all pool, protocol, creator fees and any Token-2022 transfer fee). */
  out: bigint;
  /** Actual decrease of the user's input balance (may be < amountIn if the venue rebates part of a fee to the user). */
  netIn: bigint;
  /** Opaque per-quote context the ix builder needs (e.g. DLMM bin arrays). */
  ctx?: unknown;
}

/** Any SOL/token pool that can quote exactly and synchronously over cached state. */
export interface SwapVenue extends StateSource {
  readonly name: string;          // e.g. "pumpswap:Eoe22Hd…", "dlmm:H6Bcgds…"
  readonly tokenMint: string;
  /** Changes whenever quote-relevant state changes (used for caching). */
  quoteKey(): string;
  /** Exact quote, no I/O. null if the venue would reject the trade. */
  quoteExactIn(side: SwapSide, amountIn: bigint): SwapQuote | null;
  /** Instructions for an exact-in swap with on-chain min-out (user's ATAs are assumed to exist). */
  swapExactInIxs(user: PublicKey, side: SwapSide, amountIn: bigint, minOut: bigint, q: SwapQuote): TransactionInstruction[];
  /** Program ids whose upgrade must halt trading on this venue. */
  programIds(): PublicKey[];
}
