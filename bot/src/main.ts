// Entry point: npx tsx src/main.ts   (MODE=simulate by default)
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection } from "@solana/web3.js";
import { describeConfig, loadConfig, type Config } from "./config.js";
import type { DlmmVenue, RiseVenue } from "./types.js";
import { ArbEngine } from "./engine/engine.js";
import { fetchRealized, Ledger, reconcileTokenBalances, toJson } from "./engine/ledger.js";
import { JitoClient, JitoSender, RpcSender, type Sender, type TxPreparer } from "./engine/sender.js";
import { DAILY_HALTS, ProgramUpgradeGuard, resolveOrphanInFlight, RiskGuard, WATCHED_PROGRAMS, watchedProgramsFor, type InFlightRecord } from "./engine/risk.js";
import { PairEngine } from "./engine/pair-engine.js";
import { MAX_SIM_USER, maxPairSpec, maxShredWatch } from "./engine/pair-venues.js";
import { PublicKey, type AddressLookupTableAccount } from "@solana/web3.js";
import { decodeTokenAmount } from "./engine/state.js";
import { RiseNative } from "./rise/index.js";
import { MeteoraDlmm } from "./meteora/index.js";
import { makeReadConnection, setupInfra } from "./feeds/index.js";
import { keepAliveFetch } from "./feeds/http.js";
import { AlternatingSender } from "./engine/delivery-compare.js";

export async function createVenues(conn: Connection, _cfg: Config): Promise<{ rise: RiseVenue; dlmm: DlmmVenue }> {
  // Venues quote synchronously from snapshots fed via StateSource.update(). RiseNative
  // additionally needs the connection to load the program binary (for its exact local
  // execution oracle) and to watch for program upgrades.
  const rise = new RiseNative({ connection: conn });
  await rise.init();
  return { rise, dlmm: new MeteoraDlmm() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Delivery per DELIVERY: the sender (live only) and the tx preparer (both modes; Jito adds the tip ix). */
function makeDelivery(cfg: Config, conn: Connection, sendConn: Connection | undefined): { sender?: Sender; preparer?: TxPreparer; describe: string } {
  if (cfg.delivery === "jito" || cfg.delivery === "ab") {
    const client = new JitoClient({ url: cfg.jito.blockEngineUrl, uuid: cfg.jito.uuid, tipAccountsTtlMs: cfg.jito.tipAccountsTtlMs, fetch: keepAliveFetch({ connections: 4 }) as never });
    const jito = new JitoSender(conn, {
      mode: cfg.mode, client, maxPriorityFeeLamports: cfg.risk.maxPriorityFeeLamports, maxTipLamports: cfg.risk.maxTipLamports,
      maxExecCostBpsOfProfit: cfg.risk.maxExecCostBpsOfProfit, resendMs: cfg.rebroadcastMs, commitment: cfg.commitment, log: console.log,
    });
    if (cfg.delivery === "ab") {
      // gated in loadConfig (assertLiveAbAllowed): MODE=live + CONFIRM_LIVE=yes + DELIVERY_COMPARE_LIVE=yes
      const rpc = new RpcSender(conn, { sendConn, rebroadcastMs: cfg.rebroadcastMs, commitment: cfg.commitment, log: console.log });
      const ab = new AlternatingSender(rpc, jito);
      return { sender: cfg.mode === "live" ? ab : undefined, preparer: ab, describe: "LIVE A/B: alternating rpc / jito" };
    }
    // simulate mode: tip ix is added and simulated (getTipAccounts is read-only) but nothing is ever sent
    return { sender: cfg.mode === "live" ? jito : undefined, preparer: jito, describe: "jito (sendBundle, in-tx tip)" };
  }
  const sender = cfg.mode === "live" ? new RpcSender(conn, { sendConn, rebroadcastMs: cfg.rebroadcastMs, commitment: cfg.commitment, log: console.log }) : undefined;
  return { sender, describe: sendConn ? "rpc via SEND_RPC_URL" : "rpc via RPC_URL" };
}

const PROGRAM_LABELS: Record<string, string> = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap", pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: "pump fees",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token", TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM", MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};
/** Unique, readable name per program (the upgrade guard keys its log/baseline output by name). */
const programLabel = (id: string) => PROGRAM_LABELS[id] ?? id;

/** Generic pair engines enabled by PAIRS (RISE is the ArbEngine above). */
async function createPairEngines(cfg: Config, conn: Connection, d: { ledger: Ledger; risk: RiskGuard; sender?: Sender; preparer?: TxPreparer; infra: ReturnType<typeof setupInfra> }): Promise<PairEngine[]> {
  const out: PairEngine[] = [];
  const alts: AddressLookupTableAccount[] = [];
  for (const k of cfg.pairs.lookupTables) {
    const r = await conn.getAddressLookupTable(new PublicKey(k));
    if (!r.value) throw new Error(`PAIR_LOOKUP_TABLES: ${k} not found`);
    alts.push(r.value);
  }
  for (const name of cfg.pairs.enabled) {
    if (name !== "max") continue;
    const spec = maxPairSpec(); // MAX_PUMPSWAP_POOL / MAX_DLMM_POOLS (src/pumpswap/pools.ts); default all three DLMM routes
    // without a keypair (simulate), simulate as a wallet that holds wSOL + MAX ATAs
    const user = cfg.keypair ? cfg.keypair.publicKey : cfg.pairs.simUser ?? new PublicKey(MAX_SIM_USER);
    out.push(new PairEngine({
      conn, cfg, ledger: d.ledger, risk: d.risk, sender: d.sender, preparer: d.preparer, user,
      pair: { ...spec, lookupTables: alts }, stateProvider: d.infra.stateProvider, pending: d.infra.pending,
      forceSimEveryMs: cfg.pairs.forceSimMs,
    }));
  }
  return out;
}

/** Per user: its wSOL ATA and each pair's token ATA (RISE engine = "rise", pair engines by name). */
type Holder = { user: string; wsolAta: PublicKey; tokens: { pair: string; ata: PublicKey }[] };
function balanceHolders(engine: ArbEngine | null, pairEngines: { name: string; user: PublicKey; wsolAta: PublicKey; tokenAta: PublicKey }[], riseUser: PublicKey): Holder[] {
  const m = new Map<string, Holder>();
  const add = (user: PublicKey, wsolAta: PublicKey, pair: string, ata: PublicKey) => {
    const k = user.toBase58();
    const h = m.get(k) ?? { user: k, wsolAta, tokens: [] };
    h.tokens.push({ pair, ata });
    m.set(k, h);
  };
  if (engine) add(riseUser, engine.wsolAta, "rise", engine.riseAta);
  for (const e of pairEngines) add(e.user, e.wsolAta, e.name, e.tokenAta);
  return [...m.values()];
}

/** On-chain balances per user. A missing token account reads as 0 (e.g. MAX ATA not created yet); a missing wSOL ATA skips that user. */
async function readHolderBalances(conn: Connection, holders: Holder[]): Promise<Map<string, { wsol: bigint; tokens: Record<string, bigint> }>> {
  const out = new Map<string, { wsol: bigint; tokens: Record<string, bigint> }>();
  for (const h of holders) {
    const infos = await conn.getMultipleAccountsInfo([h.wsolAta, ...h.tokens.map((t) => t.ata)], "confirmed");
    if (!infos[0]) continue;
    const tokens: Record<string, bigint> = {};
    h.tokens.forEach((t, i) => { const a = infos[i + 1]; tokens[t.pair] = a ? decodeTokenAmount(a.data) : 0n; });
    out.set(h.user, { wsol: decodeTokenAmount(infos[0].data), tokens });
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  // keep-alive undici fetch; honours HTTP(S)_PROXY so NODE_USE_ENV_PROXY=1 setups still work
  const conn = makeReadConnection(cfg);
  const ledger = new Ledger(cfg.ledgerPath);
  const risk = new RiskGuard(cfg.risk, { onHalt: (h) => ledger.append("halt", { ...h }), log: console.log });
  // Emergency stop: SIGUSR1 (or `npx tsx src/engine/estop.ts`, which writes the kill file and signals us).
  process.on("SIGUSR1", () => { risk.emergencyStop("SIGUSR1"); });
  mkdirSync(dirname(cfg.risk.pidFile), { recursive: true });
  writeFileSync(cfg.risk.pidFile, String(process.pid));
  if (risk.halt()) console.error(`starting halted: ${risk.halt()!.reason}`);

  const withRise = cfg.pairs.enabled.includes("rise");
  // optional ERPC infra: Geyser gRPC state, ShredStream hints, SEND_RPC_URL (SWQoS) delivery
  const infra = setupInfra(cfg, conn, console.log, { onShredsUdpSummary: (s) => ledger.append("latency", s), pairWatch: cfg.pairs.enabled.includes("max") ? [maxShredWatch()] : [] });
  const delivery = makeDelivery(cfg, conn, infra.sendConn);
  let engine: ArbEngine | null = null;
  if (withRise) {
    const { rise, dlmm } = await createVenues(conn, cfg);
    engine = new ArbEngine({ conn, rise, dlmm, cfg, ledger, sender: delivery.sender, preparer: delivery.preparer, risk, stateProvider: infra.stateProvider, pending: infra.pending });
  }
  const pairEngines = await createPairEngines(cfg, conn, { ledger, risk, sender: delivery.sender, preparer: delivery.preparer, infra });
  const engines: { tick(trigger?: string): Promise<unknown>; readonly inFlight: boolean; readonly lossLimitHit: boolean; readonly sessionNetLamports: bigint; close(): void }[] = [...(engine ? [engine] : []), ...pairEngines];

  // Program-upgrade guard: programdata deploy slot (45-byte dataSlice) every UPGRADE_CHECK_MS of RISE +
  // Meteora DLMM (RISE engine) and every upgradeable program a pair venue uses (PumpSwap, DLMM).
  const base = withRise ? WATCHED_PROGRAMS : [];
  const extra = await watchedProgramsFor(conn, pairEngines.flatMap((e) => e.allVenues()).flatMap((v) => v.programIds().map((p) => ({ name: programLabel(p.toBase58()), programId: p.toBase58() }))), base);
  for (const x of extra.immutable) console.log(`program ${x}: not upgradeable, not watched`);
  const upgrades = new ProgramUpgradeGuard(conn, risk, [...base, ...extra.watch], { intervalMs: cfg.risk.upgradeCheckMs, log: console.log });
  const programs = await upgrades.init();
  for (const [k, v] of Object.entries(programs)) console.log(`program ${k}: ${v}`);
  upgrades.start();

  // Orphan realize: the in-flight record names the pair, user and wSOL/token ATAs it traded through.
  // Records written by older versions have no `account`: fall back to the RISE ATAs when the RISE
  // engine runs, else the first pair engine's (and say so).
  const ataPair = engine ? { wsol: engine.wsolAta, tok: engine.riseAta, user: cfg.user } : { wsol: pairEngines[0].wsolAta, tok: pairEngines[0].tokenAta, user: pairEngines[0].user };
  const realize = (sig: string, rec: InFlightRecord) => {
    const a = rec.account;
    if (!a) console.log(`risk: orphan ${sig.slice(0, 16)}… has no account info (older record); realizing against ${ataPair.tok.toBase58()}`);
    return fetchRealized(conn, sig, a?.user ?? ataPair.user.toBase58(), a?.wsolAta ?? ataPair.wsol.toBase58(), a?.tokenAta ?? ataPair.tok.toBase58(), { kind: "other" });
  };
  const resolveOrphan = () => resolveOrphanInFlight({ risk, conn, ledger, realize, baseFeeLamports: cfg.baseFeeLamports, user: ataPair.user.toBase58(), log: console.log });
  // A tx left in flight by a previous run must be resolved before anything else is sent.
  await resolveOrphan();

  // Startup reconcile, per user: on-chain wSOL and every pair's token balance vs the ledger's running
  // totals since that user's last snapshot (RISE and MAX token accounts reconciled separately).
  const holders = balanceHolders(engine, pairEngines, cfg.user);
  const startBal = await readHolderBalances(conn, holders).catch(() => null);
  if (startBal) {
    const evs = Ledger.read(cfg.ledgerPath);
    for (const [user, bal] of startBal) {
      const rec = reconcileTokenBalances(evs, user, bal);
      const toks = Object.entries(bal.tokens).map(([k, v]) => `${k} ${v}`).join(" ");
      if (rec) {
        const tokDrift = Object.entries(rec.drift.tokens).filter(([, v]) => v !== 0n);
        const drift = rec.drift.wsol !== 0n || tokDrift.length > 0;
        console.log(`reconcile ${user.slice(0, 8)}…: on-chain wSOL ${bal.wsol} ${toks}; ledger expects wSOL ${rec.expected.wsol} ${Object.entries(rec.expected.tokens).map(([k, v]) => `${k} ${v}`).join(" ")} (${rec.outcomesSince} outcomes since ${rec.baselineTs})${drift ? ` DRIFT wSOL ${rec.drift.wsol}${tokDrift.map(([k, v]) => ` ${k} ${v}`).join("")}` : " - no drift"}${rec.noBaseline.length ? `; no baseline yet for ${rec.noBaseline.join(",")}` : ""}`);
        ledger.append("reconcile", { user, onchain: bal, ...rec });
      } else console.log(`reconcile ${user.slice(0, 8)}…: no previous balances snapshot in the ledger; baseline recorded`);
      ledger.append("balances", { user, wsol: bal.wsol, tokens: bal.tokens, ...(bal.tokens.rise !== undefined ? { rise: bal.tokens.rise } : {}), at: "start" });
    }
  }

  infra.start();
  console.log(`mode=${cfg.mode} pairs=${cfg.pairs.enabled.join(",")} user=${cfg.user.toBase58()}${cfg.keypair ? "" : " (no keypair: read-only simulation)"} delivery=${delivery.describe}`);
  if (engine) console.log(`wSOL ATA ${engine.wsolAta.toBase58()}  RISE ATA ${engine.riseAta.toBase58()}`);
  for (const p of pairEngines) console.log(`pair ${p.name}: routes ${p.routes.map((r) => `${r.name} (${r.a.name} <-> ${r.b.name})`).join(", ")}; user ${p.user.toBase58()} wSOL ATA ${p.wsolAta.toBase58()} token ATA ${p.tokenAta.toBase58()}`);
  console.log(`infra: ${Object.entries(infra.describe()).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`risk: ${Object.entries(describeConfig(cfg)).filter(([k]) => k.startsWith("risk.")).map(([k, v]) => `${k.slice(5)}=${v}`).join(" ")}`);
  ledger.append("start", { config: describeConfig(cfg), infra: infra.describe(), delivery: delivery.describe, programs, risk: risk.snapshot() });

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) { console.log(`${sig} again: exiting now`); process.exit(130); }
    stopping = true;
    console.log(`${sig}: stopping after the current tick${engines.some((e) => e.inFlight) ? " (waiting for in-flight tx)" : ""}...`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let backoff = 0;
  let trigger = "start";
  let stopReason = "signal";
  while (!stopping) {
    const t0 = Date.now();
    try {
      if (risk.orphanInFlight) await resolveOrphan();
      // serialized: the next tick starts only after this one (including any in-flight tx) is done;
      // engines tick one after another, so there is never more than one tx in flight overall
      // Each engine is isolated: an RPC error in one pair's tick must not skip the others.
      let failed = 0;
      for (const e of engines) {
        if (stopping || risk.halt()) break;
        try {
          await e.tick(trigger);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`tick error: ${msg}`);
          ledger.append("error", { message: msg });
        }
      }
      backoff = failed ? Math.min(30_000, backoff ? backoff * 2 : 1000) : 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`tick error: ${msg}`);
      ledger.append("error", { message: msg });
      backoff = Math.min(30_000, backoff ? backoff * 2 : 1000);
    }
    const sessionNet = engines.reduce((a, e) => a + e.sessionNetLamports, 0n);
    if (engines.some((e) => e.lossLimitHit) || sessionNet < -cfg.maxSessionLossLamports) {
      console.error(`session loss limit hit (${sessionNet} lamports): stopping`);
      ledger.append("halt", { reason: "session-loss", detail: `session net ${sessionNet} < -${cfg.maxSessionLossLamports}`, at: new Date().toISOString() });
      stopReason = "session-loss";
      break;
    }
    const h = risk.halt();
    if (h) {
      if (!DAILY_HALTS.has(h.reason)) {
        console.error(`halted (${h.reason}): ${h.detail}; exiting`);
        stopReason = h.reason;
        break;
      }
      // daily limit: idle (no trading) until the next UTC day, then resume
      console.error(`halted for the UTC day (${h.reason}): ${h.detail}; idling until 00:00 UTC`);
      while (!stopping && risk.halt()?.reason === h.reason) await sleep(Math.min(60_000, Math.max(1000, cfg.pollIntervalMs)));
      continue;
    }
    const wait = Math.max(0, cfg.pollIntervalMs - (Date.now() - t0));
    trigger = "timeout";
    if (!stopping && backoff) await sleep(backoff);
    // Event-driven when a push feed is configured: wake on a gRPC state change / shred hint,
    // else after the remaining poll interval (plain sleep without feeds).
    if (!stopping && (wait || infra.eventDriven)) trigger = await infra.wait(wait);
  }
  upgrades.stop();
  for (const e of engines) e.close();
  infra.close();
  const endBal = await readHolderBalances(conn, holders).catch(() => null);
  for (const [user, bal] of endBal ?? []) ledger.append("balances", { user, wsol: bal.wsol, tokens: bal.tokens, ...(bal.tokens.rise !== undefined ? { rise: bal.tokens.rise } : {}), at: "stop" });
  const sessionNetLamports = engines.reduce((a, e) => a + e.sessionNetLamports, 0n);
  ledger.append("stop", { sessionNetLamports, reason: stopReason, risk: risk.snapshot() });
  try { if (existsSync(cfg.risk.pidFile)) rmSync(cfg.risk.pidFile); } catch { /* ignore */ }
  console.log(`stopped (${stopReason}). session realized net ${toJson(sessionNetLamports)} lamports`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
