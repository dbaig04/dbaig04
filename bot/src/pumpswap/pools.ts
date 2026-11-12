// Registry of the MAX/SOL pools that were verified on-chain and validated against mainnet simulation
// (see NOTES.md, "Per-pool validation"), plus env-driven selection so the engine can pick pools by
// config instead of hard-coding one:
//
//   MAX_PUMPSWAP_POOL=<address>            default: the canonical pump pool Eoe22Hd...
//   MAX_DLMM_POOLS=5nwdWt,6PkALv,H6Bcgd    aliases (first 6 chars) or full addresses, comma-separated;
//                                          default: all three validated DLMM pools, deepest first
//   MAX_DLMM_POOL=<alias|address>          single-pool shorthand (used if MAX_DLMM_POOLS is unset)
//
// Unknown addresses are accepted (the venue code is generic) but flagged `validated: false`.
import { MAX_MINT } from "../types.js";
import { PumpSwapPool } from "./index.js";
import { DlmmSwapVenue } from "../meteora/venue.js";

export interface MaxDlmmPoolInfo {
  address: string;
  /** Pool's fee collection mode: InputOnly (0) or OnlyY (1, fee always in wSOL). */
  feeMode: "InputOnly" | "OnlyY";
  binStep: number;
  /** Base fee in 1e9 precision (base_factor * bin_step * 10). */
  baseFeeRate: bigint;
  validated: boolean;
  note: string;
}

export const MAX_PUMPSWAP_POOL_DEFAULT = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";

/** Validated MAX(X)/wSOL(Y) DLMM pools, deepest first. */
export const MAX_DLMM_POOLS: readonly MaxDlmmPoolInfo[] = Object.freeze([
  { address: "5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ", feeMode: "InputOnly", binStep: 80, baseFeeRate: 10_000_000n, validated: true, note: "deepest (~1.2k SOL TVL), base 1%" },
  { address: "6PkALvWhf2PJ3VwPsezFJdmvQ684REGkr7vLBihkNkH", feeMode: "InputOnly", binStep: 200, baseFeeRate: 10_000_000n, validated: true, note: "~320 SOL TVL, base 1%" },
  { address: "H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ", feeMode: "OnlyY", binStep: 250, baseFeeRate: 100_000_000n, validated: true, note: "tiny (~4 SOL TVL), base fee 10%; traded by the research wallet" },
] as const);

function resolve(aliasOrAddress: string): string {
  const s = aliasOrAddress.trim();
  const hit = MAX_DLMM_POOLS.find((p) => p.address === s || p.address.startsWith(s));
  if (hit) return hit.address;
  if (s.length < 32) throw new Error(`unknown MAX DLMM pool alias "${s}" (known: ${MAX_DLMM_POOLS.map((p) => p.address.slice(0, 6)).join(", ")})`);
  return s;
}

export function maxDlmmPoolInfo(address: string): MaxDlmmPoolInfo {
  return MAX_DLMM_POOLS.find((p) => p.address === address) ?? { address, feeMode: "InputOnly", binStep: 0, baseFeeRate: 0n, validated: false, note: "not in the validated registry" };
}

/** DLMM pool addresses selected by env (MAX_DLMM_POOLS / MAX_DLMM_POOL), default all validated pools. */
export function selectedMaxDlmmPools(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = env.MAX_DLMM_POOLS ?? env.MAX_DLMM_POOL;
  if (!list) return MAX_DLMM_POOLS.map((p) => p.address);
  const out = [...new Set(list.split(",").filter((x) => x.trim()).map(resolve))];
  if (out.length === 0) throw new Error("MAX_DLMM_POOLS is empty");
  return out;
}

export function selectedMaxPumpSwapPool(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAX_PUMPSWAP_POOL?.trim() || MAX_PUMPSWAP_POOL_DEFAULT;
}

/** Venues for the selected pools (one PumpSwap pool, one or more DLMM pools). */
export function createSelectedMaxVenues(env: NodeJS.ProcessEnv = process.env): { pumpswap: PumpSwapPool; dlmm: DlmmSwapVenue[] } {
  return {
    pumpswap: new PumpSwapPool({ pool: selectedMaxPumpSwapPool(env), tokenMint: MAX_MINT }),
    dlmm: selectedMaxDlmmPools(env).map((pool) => new DlmmSwapVenue({ pool, tokenMint: MAX_MINT, tokenSide: "x" })),
  };
}
