// Environment-driven configuration. Safe defaults: simulate mode, read-only,
// no keypair required. Live trading requires MODE=live AND KEYPAIR_PATH AND
// CONFIRM_LIVE=yes.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { Keypair, PublicKey } from "@solana/web3.js";

export type Mode = "simulate" | "live";
/** rpc (default) | jito | ab (live delivery A/B, gated by assertLiveAbAllowed) */
export type Delivery = "rpc" | "jito" | "ab";

/** Live delivery A/B sends real txs: throws unless MODE=live, CONFIRM_LIVE=yes, DELIVERY_COMPARE_LIVE=yes and a keypair. */
export function assertLiveAbAllowed(e: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if ((e.MODE ?? "").toLowerCase() !== "live") missing.push("MODE=live");
  if (e.CONFIRM_LIVE !== "yes") missing.push("CONFIRM_LIVE=yes");
  if (e.DELIVERY_COMPARE_LIVE !== "yes") missing.push("DELIVERY_COMPARE_LIVE=yes");
  if (!e.KEYPAIR_PATH) missing.push("KEYPAIR_PATH");
  if (missing.length) throw new Error(`live delivery A/B refused: requires ${missing.join(", ")} (it sends real transactions)`);
}

/**
 * Hard risk limits (src/engine/risk.ts). Defaults are the operator-specified limits;
 * each is env-overridable. None of them enables live trading.
 */
export interface RiskConfig {
  /** Max leg-1 input per trade (MAX_TRADE_LAMPORTS; also caps the optimizer). */
  maxInputLamports: bigint;
  maxPriorityFeeLamports: bigint;
  maxTipLamports: bigint;
  /** priority + tip <= this share (bps) of the expected profit before execution costs (out − in). 1000 = 10%. */
  maxExecCostBpsOfProfit: bigint;
  /** Min expected net profit after all trading and execution costs (base + priority + tip). */
  minNetProfitLamports: bigint;
  /** Halt for the UTC day once Σ(fee + tip) of landed txs reaches this. Persisted. */
  maxDailyExecCostLamports: bigint;
  /** Halt for the UTC day once the day's realized SOL net <= -this. Persisted. */
  maxDailyLossLamports: bigint;
  /** Halt after this many consecutive unsuccessful txs. Persisted until cleared (estop.ts clear-failures). */
  maxConsecutiveFailures: number;
  /** Count expired/dropped (never-landed) txs as failures for the streak. */
  expiredCountsAsFailure: boolean;
  /** Refuse to build/send when the snapshot slot is more than this many slots behind the newest slot seen. */
  maxStaleSlots: number;
  /** ...or when the snapshot data is older than this many ms. */
  maxStaleMs: number;
  /** Sender refuses a tx whose exact message was not simulated OK within this many ms. */
  simMaxAgeMs: number;
  /** Emergency-stop kill file, checked every tick. */
  killFile: string;
  /** Persistent risk state (daily costs/PnL, failure streak, in-flight tx). */
  statePath: string;
  /** PID file (lets estop.ts send SIGUSR1). */
  pidFile: string;
  /** Period of the programdata deploy-slot check for the RISE and DLMM programs. */
  upgradeCheckMs: number;
}

export interface JitoConfig {
  /** Block engine base URL (sendBundle / getTipAccounts / getBundleStatuses). */
  blockEngineUrl: string;
  /** Optional x-jito-auth UUID. */
  uuid?: string;
  /** Tip-account cache lifetime. */
  tipAccountsTtlMs: number;
}
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

/**
 * ERPC "Shreds UDP Forwarding": raw turbine shreds forwarded as UDP to this host. Enabled iff
 * SHREDS_UDP_PORT is set; then it replaces the gRPC ShredStream path (SHREDSTREAM_ENDPOINT).
 */
export interface ShredsUdpConfig {
  port: number;
  bind: string;
  /** Requested SO_RCVBUF bytes (capped by net.core.rmem_max). */
  rcvbuf: number;
  /** Source IPs accepted (ERPC's forwarders). Empty = accept all, with a warning. */
  allowedSources: string[];
  /** Expected cluster shred version (optional). */
  shredVersion?: number;
  maxSlotLag: number;
  maxBufferedBytes: number;
  recovery: boolean;
  summaryMs: number;
  staleMs: number;
  resolveLookupTables: boolean;
  holdWindowMs: number;
  /** SHREDSTREAM_ENDPOINT was also set and is ignored. */
  overridesShredstream: boolean;
}

/** The reference wallet whose strategy this bot mirrors; used as SIM_USER by default. */
export const REFERENCE_WALLET = "24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU";

/** Pairs the bot trades (PAIRS, comma-separated). "rise" = the original RISE engine (default). */
export const KNOWN_PAIRS = ["rise", "max"] as const;
export type PairName = (typeof KNOWN_PAIRS)[number];

export function parsePairs(v: string | undefined): PairName[] {
  const list = (v ?? "rise").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const p of list) if (!(KNOWN_PAIRS as readonly string[]).includes(p)) throw new Error(`PAIRS: unknown pair "${p}" (known: ${KNOWN_PAIRS.join(", ")})`);
  if (!list.length) throw new Error("PAIRS must name at least one pair");
  return [...new Set(list)] as PairName[];
}

/** Generic pair engines (src/engine/pair-engine.ts). */
export interface PairsConfig {
  /** PAIRS (default "rise": the RISE engine only, unchanged behaviour). */
  enabled: PairName[];
  /** Wallet the pair engines simulate as without a keypair (PAIR_SIM_USER; default per pair). */
  simUser?: PublicKey;
  /** Address lookup tables for pair txs that do not fit a legacy message (PAIR_LOOKUP_TABLES). */
  lookupTables: string[];
  /** Simulate mode only: sub-floor latency probe sims every N ms (PAIR_FORCE_SIM_MS, 0 = off). */
  forceSimMs: number;
}

/** Local full-transaction simulation (src/engine/local-sim.ts). */
export interface LocalSimConfig {
  /** LOCAL_SIM: off (default) | shadow (simulate mode only: local LiteSVM sim of every pre/final sim's exact tx, compared with the RPC sim, which stays the gate). */
  mode: "off" | "shadow";
  /** LOCAL_SIM_TIMEOUT_MS: per-simulation deadline; past it the worker is killed and respawned. */
  timeoutMs: number;
  /** LOCAL_SIM_CACHE_DIR: program binaries cached per deploy slot. */
  cacheDir: string;
  /** LOCAL_SIM_STATE_CHECK: on a mismatch, re-read the tx's writable accounts at the RPC sim's slot (1 RPC call). */
  stateCheck: boolean;
}

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
  /** Max ms to wait for the simulation RPC to reach the snapshot slot (minContextSlot) before rejecting. */
  simSlotWaitMs: number;
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
  shredsUdp: ShredsUdpConfig | null;
  /** Skip a trade when ShredStream shows a competing arb on the pool not yet in our snapshot. Off by default. */
  holdOnCompetingArb: boolean;
  /** Period of the latency summary ledger row (0 = off). */
  latencySummaryMs: number;
  /** Keep the SEND_RPC_URL connection warm with a cheap request every N ms (0 = off). */
  sendWarmMs: number;
  /** Background blockhash refresh period / age after which the cached one is not used (src/engine/blockhash.ts). */
  blockhashRefreshMs: number;
  blockhashStaleMs: number;
  /** Append a per-tick "tick" latency row to the ledger (bench / diagnostics). */
  tickLatencyRows: boolean;
  /** Bench only, ignored unless MODE=simulate: build + simulate the best plan every tick even below the floor (measures build + sim RTT). */
  benchForceBuild: boolean;
  /** How txs are delivered in live mode: rpc (SEND_RPC_URL / RPC_URL, default) or jito (sendBundle). */
  delivery: Delivery;
  jito: JitoConfig;
  risk: RiskConfig;
  pairs: PairsConfig;
  localSim: LocalSimConfig;
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
    const deliveryRaw = (env("DELIVERY", "rpc") as string).toLowerCase();
    if (deliveryRaw !== "rpc" && deliveryRaw !== "jito" && deliveryRaw !== "ab") throw new Error(`DELIVERY must be rpc|jito, got ${deliveryRaw}`);
    if (deliveryRaw === "ab") assertLiveAbAllowed(process.env);
    const delivery = deliveryRaw as Delivery;
    const risk = riskFromEnv();
    const localSimMode = (env("LOCAL_SIM", "off") as string).toLowerCase();
    if (localSimMode !== "off" && localSimMode !== "shadow") throw new Error(`LOCAL_SIM must be off|shadow, got ${localSimMode}`);
    if (localSimMode === "shadow" && mode !== "simulate") throw new Error("LOCAL_SIM=shadow is simulation-only (MODE=simulate)");
    return {
      rpcUrl: env("RPC_URL", "https://api.mainnet-beta.solana.com")!,
      mode,
      keypair,
      user,
      profitFloorLamports: big("PROFIT_FLOOR_LAMPORTS", 100_000n),
      priorityFeeLamports: big("PRIORITY_FEE_LAMPORTS", 50_000n),
      baseFeeLamports: big("BASE_FEE_LAMPORTS", 5_000n),
      maxTradeLamports: risk.maxInputLamports,
      minTradeLamports: big("MIN_TRADE_LAMPORTS", 1_000_000n),
      maxWsolLamports: big("MAX_WSOL_LAMPORTS", 5_000_000_000n),
      legSlippageBps: big("LEG_SLIPPAGE_BPS", 0n),
      simToleranceLamports: big("SIM_TOLERANCE_LAMPORTS", 20_000n),
      simToleranceBps: big("SIM_TOLERANCE_BPS", 1_000n),
      simSlotWaitMs: int("SIM_SLOT_WAIT_MS", 400, 0, 5_000) ?? 400,
      cuHeadroomBps: big("CU_HEADROOM_BPS", 11_500n),
      pollIntervalMs: num("POLL_INTERVAL_MS", 1000),
      ledgerPath: env("LEDGER_PATH", "data/ledger.jsonl")!,
      maxSessionLossLamports: big("MAX_SESSION_LOSS_LAMPORTS", 2_000_000n),
      rebroadcastMs: num("REBROADCAST_MS", 2000),
      commitment,
      sendRpcUrl: url("SEND_RPC_URL", ["https:", "http:"]),
      wsUrl: url("WS_URL", ["wss:", "ws:"]),
      grpc: grpcFromEnv(commitment),
      ...shredFeedsFromEnv(),
      holdOnCompetingArb: bool("SHREDS_HOLD_ON_COMPETING_ARB", false),
      latencySummaryMs: num("LATENCY_SUMMARY_MS", 60_000),
      sendWarmMs: num("SEND_RPC_WARM_MS", 0),
      blockhashRefreshMs: num("BLOCKHASH_REFRESH_MS", 2_000),
      blockhashStaleMs: num("BLOCKHASH_STALE_MS", 20_000),
      tickLatencyRows: bool("LEDGER_TICK_LATENCY", false),
      benchForceBuild: mode === "simulate" && bool("BENCH_FORCE_BUILD", false),
      delivery,
      jito: {
        blockEngineUrl: url("JITO_BLOCK_ENGINE_URL", ["https:", "http:"]) ?? "https://mainnet.block-engine.jito.wtf",
        uuid: env("JITO_UUID"),
        tipAccountsTtlMs: num("JITO_TIP_ACCOUNTS_TTL_MS", 600_000),
      },
      risk,
      pairs: {
        enabled: parsePairs(env("PAIRS")),
        simUser: env("PAIR_SIM_USER") ? new PublicKey(env("PAIR_SIM_USER")!) : undefined,
        lookupTables: (env("PAIR_LOOKUP_TABLES") ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => new PublicKey(x).toBase58()),
        forceSimMs: mode === "simulate" ? num("PAIR_FORCE_SIM_MS", 0) : 0,
      },
      localSim: {
        mode: localSimMode as LocalSimConfig["mode"],
        timeoutMs: int("LOCAL_SIM_TIMEOUT_MS", 500, 20, 10_000) ?? 500,
        cacheDir: env("LOCAL_SIM_CACHE_DIR", "data/local-sim")!,
        stateCheck: bool("LOCAL_SIM_STATE_CHECK", true),
      },
    };
  } finally {
    process.env = saved;
  }
}

/** Operator-specified risk limits. Defaults are exact; env vars only override them. */
export const RISK_DEFAULTS = {
  maxInputLamports: 100_000_000n, // 0.1 SOL
  maxPriorityFeeLamports: 50_000n,
  maxTipLamports: 50_000n,
  maxExecCostBpsOfProfit: 1_000n, // 10%
  minNetProfitLamports: 100_000n,
  maxDailyExecCostLamports: 5_000_000n,
  maxDailyLossLamports: 10_000_000n,
  maxConsecutiveFailures: 3,
} as const;

function riskFromEnv(): RiskConfig {
  const failures = num("MAX_CONSECUTIVE_FAILURES", RISK_DEFAULTS.maxConsecutiveFailures);
  if (!Number.isInteger(failures) || failures < 1) throw new Error("MAX_CONSECUTIVE_FAILURES must be an integer >= 1");
  const bps = big("MAX_EXEC_COST_BPS_OF_PROFIT", RISK_DEFAULTS.maxExecCostBpsOfProfit);
  if (bps > 10_000n) throw new Error("MAX_EXEC_COST_BPS_OF_PROFIT must be <= 10000");
  return {
    maxInputLamports: big("MAX_TRADE_LAMPORTS", RISK_DEFAULTS.maxInputLamports),
    maxPriorityFeeLamports: big("MAX_PRIORITY_FEE_LAMPORTS", RISK_DEFAULTS.maxPriorityFeeLamports),
    maxTipLamports: big("MAX_TIP_LAMPORTS", RISK_DEFAULTS.maxTipLamports),
    maxExecCostBpsOfProfit: bps,
    minNetProfitLamports: big("MIN_NET_PROFIT_LAMPORTS", RISK_DEFAULTS.minNetProfitLamports),
    maxDailyExecCostLamports: big("MAX_DAILY_EXEC_COST_LAMPORTS", RISK_DEFAULTS.maxDailyExecCostLamports),
    maxDailyLossLamports: big("MAX_DAILY_LOSS_LAMPORTS", RISK_DEFAULTS.maxDailyLossLamports),
    maxConsecutiveFailures: failures,
    expiredCountsAsFailure: bool("EXPIRED_COUNTS_AS_FAILURE", true),
    maxStaleSlots: num("MAX_STALE_SLOTS", 8),
    maxStaleMs: num("MAX_STALE_MS", 3_000),
    simMaxAgeMs: num("SIM_MAX_AGE_MS", 3_000),
    killFile: env("KILL_FILE", "data/STOP")!,
    statePath: env("RISK_STATE_PATH", "data/risk-state.json")!,
    pidFile: env("PID_FILE", "data/bot.pid")!,
    upgradeCheckMs: num("UPGRADE_CHECK_MS", 30_000),
  };
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
    debounceMs: num("GRPC_DEBOUNCE_MS", 3),
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

function int(name: string, def: number | undefined, min: number, max: number): number | undefined {
  const v = env(name);
  if (v === undefined) return def;
  const n = Number(v.replace(/_/g, ""));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}], got ${v}`);
  return n;
}

/** Comma-separated IP list (no hostnames: compared against the UDP source address). */
function ipList(name: string): string[] {
  const v = env(name);
  if (v === undefined) return [];
  const out = v.split(",").map((x) => x.trim()).filter(Boolean);
  for (const ip of out) if (isIP(ip) === 0) throw new Error(`${name} must be a comma-separated list of IP addresses, got ${ip}`);
  return out;
}

function shredFeedsFromEnv(): { shreds: ShredsConfig | null; shredsUdp: ShredsUdpConfig | null } {
  const shreds = shredsFromEnv();
  const port = int("SHREDS_UDP_PORT", undefined, 1, 65_535);
  if (port === undefined) return { shreds, shredsUdp: null };
  const latency = num("LATENCY_SUMMARY_MS", 60_000);
  return {
    // only one shred source at a time: UDP wins
    shreds: null,
    shredsUdp: {
      port,
      bind: env("SHREDS_UDP_BIND", "0.0.0.0")!,
      rcvbuf: int("SHREDS_UDP_RCVBUF", 64 * 1024 * 1024, 65_536, 2 ** 31 - 1)!,
      allowedSources: ipList("SHREDS_UDP_ALLOWED_SOURCES"),
      shredVersion: int("SHREDS_UDP_SHRED_VERSION", undefined, 0, 65_535),
      maxSlotLag: int("SHREDS_UDP_MAX_SLOT_LAG", 12, 1, 1_000)!,
      maxBufferedBytes: int("SHREDS_UDP_MAX_BUFFER_MB", 128, 8, 16_384)! * 1024 * 1024,
      recovery: bool("SHREDS_UDP_RECOVERY", true),
      summaryMs: num("SHREDS_UDP_SUMMARY_MS", latency > 0 ? latency : 60_000),
      staleMs: num("SHREDS_UDP_STALE_MS", 5_000),
      resolveLookupTables: bool("SHREDS_RESOLVE_ALTS", true),
      holdWindowMs: num("SHREDS_HOLD_WINDOW_MS", 1_500),
      overridesShredstream: shreds !== null,
    },
  };
}

const SECRET_KEYS = new Set(["xToken", "uuid"]);
const URL_KEYS = new Set(["rpcUrl", "sendRpcUrl", "wsUrl", "endpoint", "blockEngineUrl"]);

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
    else if (k === "allowedSources" && Array.isArray(v)) out[name] = v.length ? `${v.length} address(es)` : "(any)";
    else if (URL_KEYS.has(k)) out[name] = redactUrl(v as string | undefined);
    else if (v instanceof PublicKey) out[name] = v.toBase58();
    else if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) put(k2, v2, `${name}.`);
    else out[name] = v === null ? "(off)" : String(v);
  };
  for (const [k, v] of Object.entries(c)) put(k, v);
  return out;
}
