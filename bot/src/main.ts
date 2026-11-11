// Entry point: npx tsx src/main.ts   (MODE=simulate by default)
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection } from "@solana/web3.js";
import { describeConfig, loadConfig, type Config } from "./config.js";
import type { DlmmVenue, RiseVenue } from "./types.js";
import { ArbEngine } from "./engine/engine.js";
import { fetchRealized, Ledger, reconcileBalances, toJson } from "./engine/ledger.js";
import { JitoClient, JitoSender, RpcSender, type Sender, type TxPreparer } from "./engine/sender.js";
import { DAILY_HALTS, ProgramUpgradeGuard, resolveOrphanInFlight, RiskGuard, WATCHED_PROGRAMS } from "./engine/risk.js";
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

async function readAtaBalances(conn: Connection, engine: ArbEngine): Promise<{ wsol: bigint; rise: bigint } | null> {
  const [w, r] = await conn.getMultipleAccountsInfo([engine.wsolAta, engine.riseAta], "confirmed");
  if (!w || !r) return null;
  return { wsol: decodeTokenAmount(w.data), rise: decodeTokenAmount(r.data) };
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

  const { rise, dlmm } = await createVenues(conn, cfg);
  // optional ERPC infra: Geyser gRPC state, ShredStream hints, SEND_RPC_URL (SWQoS) delivery
  const infra = setupInfra(cfg, conn, console.log, { onShredsUdpSummary: (s) => ledger.append("latency", s) });
  const delivery = makeDelivery(cfg, conn, infra.sendConn);
  const engine = new ArbEngine({ conn, rise, dlmm, cfg, ledger, sender: delivery.sender, preparer: delivery.preparer, risk, stateProvider: infra.stateProvider, pending: infra.pending });

  // Program-upgrade guard: RISE + Meteora DLMM programdata deploy slot (45-byte dataSlice) every UPGRADE_CHECK_MS.
  const upgrades = new ProgramUpgradeGuard(conn, risk, WATCHED_PROGRAMS, { intervalMs: cfg.risk.upgradeCheckMs, log: console.log });
  const programs = await upgrades.init();
  for (const [k, v] of Object.entries(programs)) console.log(`program ${k}: ${v}`);
  upgrades.start();

  const realize = (sig: string) => fetchRealized(conn, sig, cfg.user.toBase58(), engine.wsolAta.toBase58(), engine.riseAta.toBase58(), { kind: "other" });
  const resolveOrphan = () => resolveOrphanInFlight({ risk, conn, ledger, realize, baseFeeLamports: cfg.baseFeeLamports, user: cfg.user.toBase58(), log: console.log });
  // A tx left in flight by a previous run must be resolved before anything else is sent.
  await resolveOrphan();

  // Startup reconcile: on-chain wSOL/RISE vs the ledger's running totals since the last snapshot.
  const bal = await readAtaBalances(conn, engine).catch(() => null);
  if (bal) {
    const evs = Ledger.read(cfg.ledgerPath);
    const rec = reconcileBalances(evs, cfg.user.toBase58(), bal);
    if (rec) {
      const drift = rec.drift.wsol !== 0n || rec.drift.rise !== 0n;
      console.log(`reconcile: on-chain wSOL ${bal.wsol} RISE ${bal.rise}; ledger expects wSOL ${rec.expected.wsol} RISE ${rec.expected.rise} (${rec.outcomesSince} outcomes since ${rec.baselineTs})${drift ? ` DRIFT wSOL ${rec.drift.wsol} RISE ${rec.drift.rise}` : " - no drift"}`);
      ledger.append("reconcile", { user: cfg.user.toBase58(), onchain: bal, ...rec });
    } else console.log(`reconcile: no previous balances snapshot for ${cfg.user.toBase58()} in the ledger; baseline recorded`);
    ledger.append("balances", { user: cfg.user.toBase58(), wsol: bal.wsol, rise: bal.rise, at: "start" });
  }

  infra.start();
  console.log(`mode=${cfg.mode} user=${cfg.user.toBase58()}${cfg.keypair ? "" : " (no keypair: read-only simulation)"} delivery=${delivery.describe}`);
  console.log(`wSOL ATA ${engine.wsolAta.toBase58()}  RISE ATA ${engine.riseAta.toBase58()}`);
  console.log(`infra: ${Object.entries(infra.describe()).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`risk: ${Object.entries(describeConfig(cfg)).filter(([k]) => k.startsWith("risk.")).map(([k, v]) => `${k.slice(5)}=${v}`).join(" ")}`);
  ledger.append("start", { config: describeConfig(cfg), infra: infra.describe(), delivery: delivery.describe, programs, risk: risk.snapshot() });

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) { console.log(`${sig} again: exiting now`); process.exit(130); }
    stopping = true;
    console.log(`${sig}: stopping after the current tick${engine.inFlight ? " (waiting for in-flight tx)" : ""}...`);
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
      // serialized: the next tick starts only after this one (including any in-flight tx) is done
      await engine.tick(trigger);
      backoff = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`tick error: ${msg}`);
      ledger.append("error", { message: msg });
      backoff = Math.min(30_000, backoff ? backoff * 2 : 1000);
    }
    if (engine.lossLimitHit) {
      console.error(`session loss limit hit (${engine.sessionNetLamports} lamports): stopping`);
      ledger.append("halt", { reason: "session-loss", detail: `session net ${engine.sessionNetLamports} < -${cfg.maxSessionLossLamports}`, at: new Date().toISOString() });
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
  (engine as { close?: () => void }).close?.();
  infra.close();
  const endBal = await readAtaBalances(conn, engine).catch(() => null);
  if (endBal) ledger.append("balances", { user: cfg.user.toBase58(), wsol: endBal.wsol, rise: endBal.rise, at: "stop" });
  ledger.append("stop", { sessionNetLamports: engine.sessionNetLamports, reason: stopReason, risk: risk.snapshot() });
  try { if (existsSync(cfg.risk.pidFile)) rmSync(cfg.risk.pidFile); } catch { /* ignore */ }
  console.log(`stopped (${stopReason}). session realized net ${toJson(engine.sessionNetLamports)} lamports`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
