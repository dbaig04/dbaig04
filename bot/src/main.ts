// Entry point: npx tsx src/main.ts   (MODE=simulate by default)
import { Connection } from "@solana/web3.js";
import { describeConfig, loadConfig, type Config } from "./config.js";
import type { DlmmVenue, RiseVenue } from "./types.js";
import { ArbEngine } from "./engine/engine.js";
import { Ledger, toJson } from "./engine/ledger.js";
import { RpcSender } from "./engine/sender.js";
import { RiseNative } from "./rise/index.js";
import { MeteoraDlmm } from "./meteora/index.js";
import { makeReadConnection, setupInfra } from "./feeds/index.js";

export async function createVenues(conn: Connection, _cfg: Config): Promise<{ rise: RiseVenue; dlmm: DlmmVenue }> {
  // Venues quote synchronously from snapshots fed via StateSource.update(). RiseNative
  // additionally needs the connection to load the program binary (for its exact local
  // execution oracle) and to watch for program upgrades.
  const rise = new RiseNative({ connection: conn });
  await rise.init();
  return { rise, dlmm: new MeteoraDlmm() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  // keep-alive undici fetch; honours HTTP(S)_PROXY so NODE_USE_ENV_PROXY=1 setups still work
  const conn = makeReadConnection(cfg);
  const ledger = new Ledger(cfg.ledgerPath);
  const { rise, dlmm } = await createVenues(conn, cfg);
  // optional ERPC infra: Geyser gRPC state, ShredStream hints, SEND_RPC_URL (SWQoS) delivery
  const infra = setupInfra(cfg, conn);
  const sender = cfg.mode === "live" ? new RpcSender(conn, { sendConn: infra.sendConn, rebroadcastMs: cfg.rebroadcastMs, commitment: cfg.commitment, log: console.log }) : undefined;
  const engine = new ArbEngine({ conn, rise, dlmm, cfg, ledger, sender, stateProvider: infra.stateProvider, pending: infra.pending });
  infra.start();

  console.log(`mode=${cfg.mode} user=${cfg.user.toBase58()}${cfg.keypair ? "" : " (no keypair: read-only simulation)"}`);
  console.log(`wSOL ATA ${engine.wsolAta.toBase58()}  RISE ATA ${engine.riseAta.toBase58()}`);
  console.log(`infra: ${Object.entries(infra.describe()).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  ledger.append("start", { config: describeConfig(cfg), infra: infra.describe() });

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
  while (!stopping) {
    const t0 = Date.now();
    try {
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
      break;
    }
    const wait = Math.max(0, cfg.pollIntervalMs - (Date.now() - t0));
    trigger = "timeout";
    if (!stopping && backoff) await sleep(backoff);
    // Event-driven when a push feed is configured: wake on a gRPC state change / shred hint,
    // else after the remaining poll interval (plain sleep without feeds).
    if (!stopping && (wait || infra.eventDriven)) trigger = await infra.wait(wait);
  }
  infra.close();
  ledger.append("stop", { sessionNetLamports: engine.sessionNetLamports });
  console.log(`stopped. session realized net ${toJson(engine.sessionNetLamports)} lamports`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
