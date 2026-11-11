// Environment-driven configuration. Safe defaults: simulate mode, read-only,
// no keypair required. Live trading requires MODE=live AND KEYPAIR_PATH AND
// CONFIRM_LIVE=yes.
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

export type Mode = "simulate" | "live";
export type FeedCommitment = "processed" | "confirmed" | "finalized";

/** Yellowstone Geyser gRPC (ERPC Geyser gRPC). Enabled iff GRPC_ENDPOINT is set. */
export interface GrpcConfig {
  endpoint: string;
  /** Sent as the `x-token` metadata header when set. */
  xToken?: string;
  commitment: FeedCommitment;
  pingMs: number;
  /** No stream message for this long => stale: stop trusting the stream, poll RPC. */
  staleMs: number;
  /** Per-slot debounce before signalling the engine. */
  debounceMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

/** ShredStream entries (ERPC Shreds, Jito shredstream-proxy compatible). Enabled iff SHREDSTREAM_ENDPOINT is set. */
export interface ShredsConfig {
  endpoint: string;
  /** Sent as `x-token` metadata when set (ERPC may authenticate by IP instead). */
  xToken?: string;
  /** Ask the server to pre-filter by account (ERPC extension, marked experimental by ERPC). Off: full stream, client-side filter. */
  serverFilter: boolean;
  staleMs: number;
  /** Fetch v0 lookup tables via RPC for relevant-looking txs so hidden pool/RISE keys are detected. */
  resolveLookupTables: boolean;
  /** How long a pending hit counts for the hold rule. */
  holdWindowMs: number;
}

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
  /** Separate delivery endpoint for sendRawTransaction (ERPC SWQoS). Unset = RPC_URL. */
  sendRpcUrl?: string;
  /** WebSocket endpoint for the read RPC (web3.js default derives it from RPC_URL). */
  wsUrl?: string;
  grpc: GrpcConfig | null;
  shreds: ShredsConfig | null;
  /** Skip a trade when ShredStream shows a competing arb on the pool not yet in our snapshot. Off by default. */
  holdOnCompetingArb: boolean;
  /** Period of the latency summary ledger row (0 = off). */
  latencySummaryMs: number;
  /** Keep the SEND_RPC_URL connection warm with a cheap request every N ms (0 = off). */
  sendWarmMs: number;
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

function bool(name: string, def: boolean): boolean {
  const v = env(name);
  if (v === undefined) return def;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be a boolean (1/0, true/false), got ${v}`);
}

function feedCommitment(name: string, def: FeedCommitment): FeedCommitment {
  const v = (env(name, def) as string).toLowerCase();
  if (v !== "processed" && v !== "confirmed" && v !== "finalized") throw new Error(`${name} must be processed|confirmed|finalized, got ${v}`);
  return v;
}

function url(name: string, schemes: string[]): string | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name} must be a URL (${schemes.join("/")}), got an invalid value`); }
  if (!schemes.includes(u.protocol)) throw new Error(`${name} must use ${schemes.join(" or ")}`);
  return v;
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
      sendRpcUrl: url("SEND_RPC_URL", ["https:", "http:"]),
      wsUrl: url("WS_URL", ["wss:", "ws:"]),
      grpc: grpcFromEnv(commitment),
      shreds: shredsFromEnv(),
      holdOnCompetingArb: bool("SHREDS_HOLD_ON_COMPETING_ARB", false),
      latencySummaryMs: num("LATENCY_SUMMARY_MS", 60_000),
      sendWarmMs: num("SEND_RPC_WARM_MS", 0),
    };
  } finally {
    process.env = saved;
  }
}

function grpcFromEnv(commitment: Config["commitment"]): GrpcConfig | null {
  const endpoint = url("GRPC_ENDPOINT", ["https:", "http:"]);
  if (!endpoint) return null;
  return {
    endpoint,
    xToken: env("GRPC_X_TOKEN"),
    commitment: feedCommitment("GRPC_COMMITMENT", commitment),
    pingMs: num("GRPC_PING_MS", 10_000),
    staleMs: num("GRPC_STALE_MS", 3_000),
    debounceMs: num("GRPC_DEBOUNCE_MS", 20),
    reconnectMinMs: num("GRPC_RECONNECT_MIN_MS", 250),
    reconnectMaxMs: num("GRPC_RECONNECT_MAX_MS", 15_000),
  };
}

function shredsFromEnv(): ShredsConfig | null {
  const endpoint = url("SHREDSTREAM_ENDPOINT", ["https:", "http:"]);
  if (!endpoint) return null;
  return {
    endpoint,
    xToken: env("SHREDSTREAM_X_TOKEN"),
    serverFilter: bool("SHREDSTREAM_SERVER_FILTER", false),
    staleMs: num("SHREDSTREAM_STALE_MS", 5_000),
    resolveLookupTables: bool("SHREDS_RESOLVE_ALTS", true),
    holdWindowMs: num("SHREDS_HOLD_WINDOW_MS", 1_500),
  };
}

const SECRET_KEYS = new Set(["xToken"]);
const URL_KEYS = new Set(["rpcUrl", "sendRpcUrl", "wsUrl", "endpoint"]);

/** Hide URL paths/queries (providers embed API keys there): keep scheme://host only. */
export function redactUrl(u: string | null | undefined): string {
  if (!u) return "(unset)";
  try {
    const x = new URL(u);
    const hidden = (x.pathname && x.pathname !== "/") || x.search || x.username ? "/…" : "";
    return `${x.protocol}//${x.host}${hidden}`;
  } catch {
    return "(invalid url)";
  }
}

/** Redacted view for logging: no key material, no tokens, no URL paths/queries. */
export function describeConfig(c: Config): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown, prefix = "") => {
    const name = prefix + k;
    if (k === "keypair") out[name] = v ? "(loaded)" : "(none)";
    else if (SECRET_KEYS.has(k)) out[name] = v ? "(set)" : "(unset)";
    else if (URL_KEYS.has(k)) out[name] = redactUrl(v as string | undefined);
    else if (v instanceof PublicKey) out[name] = v.toBase58();
    else if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) put(k2, v2, `${name}.`);
    else out[name] = v === null ? "(off)" : String(v);
  };
  for (const [k, v] of Object.entries(c)) put(k, v);
  return out;
}
