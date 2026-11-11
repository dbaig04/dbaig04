// Environment-driven configuration. Safe defaults: simulate mode, read-only,
// no keypair required. Live trading requires MODE=live AND KEYPAIR_PATH AND
// CONFIRM_LIVE=yes.
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

export type Mode = "simulate" | "live";

/** The reference wallet whose strategy this bot mirrors; used as SIM_USER by default. */
export const REFERENCE_WALLET = "24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU";

export interface Config {
  rpcUrl: string;
  mode: Mode;
  keypair: Keypair | null;
  /** The wallet whose token accounts are traded / simulated against. */
  user: PublicKey;
  /** Minimum net profit (after tx fees) required, in lamports. Enforced on-chain via leg-2 min-out. */
  profitFloorLamports: bigint;
  /** Target priority fee per tx in lamports (CU price is derived from CU limit). */
  priorityFeeLamports: bigint;
  /** Base fee per signature. */
  baseFeeLamports: bigint;
  /** Max lamports per trade (leg-1 input). */
  maxTradeLamports: bigint;
  /** Smallest trade the optimizer considers. */
  minTradeLamports: bigint;
  /** Cap on how much of the wSOL ATA balance may be used. */
  maxWsolLamports: bigint;
  /** Slippage on the intermediate (leg-1) amount, in bps. 0 = exact quoted amount. */
  legSlippageBps: bigint;
  /** Simulated vs expected profit tolerance. */
  simToleranceLamports: bigint;
  simToleranceBps: bigint;
  /** CU headroom multiplier over simulated usage, in bps (11500 = 1.15x). */
  cuHeadroomBps: bigint;
  pollIntervalMs: number;
  ledgerPath: string;
  /** Stop the bot when session realized net PnL falls below -this. */
  maxSessionLossLamports: bigint;
  /** Rebroadcast period for the RPC sender. */
  rebroadcastMs: number;
  commitment: "processed" | "confirmed" | "finalized";
}

function env(name: string, def?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function big(name: string, def: bigint): bigint {
  const v = env(name);
  if (v === undefined) return def;
  if (!/^\d+$/.test(v.replace(/_/g, ""))) throw new Error(`${name} must be a non-negative integer, got ${v}`);
  return BigInt(v.replace(/_/g, ""));
}

function num(name: string, def: number): number {
  const v = env(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got ${v}`);
  return n;
}

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`keypair file ${path} must be a JSON array of bytes`);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const saved = process.env;
  // allow injecting an env map (tests)
  if (e !== process.env) process.env = e;
  try {
    const modeRaw = (env("MODE", "simulate") as string).toLowerCase();
    if (modeRaw !== "simulate" && modeRaw !== "live") throw new Error(`MODE must be simulate|live, got ${modeRaw}`);
    const mode = modeRaw as Mode;
    const kpPath = env("KEYPAIR_PATH");
    const keypair = kpPath ? loadKeypair(kpPath) : null;
    if (mode === "live") {
      if (!keypair) throw new Error("MODE=live requires KEYPAIR_PATH");
      if (env("CONFIRM_LIVE") !== "yes") throw new Error("MODE=live requires CONFIRM_LIVE=yes");
    }
    const user = keypair ? keypair.publicKey : new PublicKey(env("SIM_USER", REFERENCE_WALLET)!);
    const commitment = env("COMMITMENT", "confirmed") as Config["commitment"];
    return {
      rpcUrl: env("RPC_URL", "https://api.mainnet-beta.solana.com")!,
      mode,
      keypair,
      user,
      profitFloorLamports: big("PROFIT_FLOOR_LAMPORTS", 100_000n),
      priorityFeeLamports: big("PRIORITY_FEE_LAMPORTS", 50_000n),
      baseFeeLamports: big("BASE_FEE_LAMPORTS", 5_000n),
      maxTradeLamports: big("MAX_TRADE_LAMPORTS", 5_000_000_000n),
      minTradeLamports: big("MIN_TRADE_LAMPORTS", 1_000_000n),
      maxWsolLamports: big("MAX_WSOL_LAMPORTS", 5_000_000_000n),
      legSlippageBps: big("LEG_SLIPPAGE_BPS", 0n),
      simToleranceLamports: big("SIM_TOLERANCE_LAMPORTS", 20_000n),
      simToleranceBps: big("SIM_TOLERANCE_BPS", 1_000n),
      cuHeadroomBps: big("CU_HEADROOM_BPS", 11_500n),
      pollIntervalMs: num("POLL_INTERVAL_MS", 1000),
      ledgerPath: env("LEDGER_PATH", "data/ledger.jsonl")!,
      maxSessionLossLamports: big("MAX_SESSION_LOSS_LAMPORTS", 2_000_000n),
      rebroadcastMs: num("REBROADCAST_MS", 2000),
      commitment,
    };
  } finally {
    process.env = saved;
  }
}

/** Redacted view for logging. */
export function describeConfig(c: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "keypair") out[k] = v ? "(loaded)" : "(none)";
    else if (v instanceof PublicKey) out[k] = v.toBase58();
    else out[k] = String(v);
  }
  return out;
}
