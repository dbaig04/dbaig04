// Entry point: npx tsx src/main.ts   (MODE=simulate by default)
import { Connection } from "@solana/web3.js";
import { describeConfig, loadConfig, type Config } from "./config.js";
import type { DlmmVenue, RiseVenue } from "./types.js";
import { ArbEngine } from "./engine/engine.js";
import { Ledger, toJson } from "./engine/ledger.js";
import { RpcSender } from "./engine/sender.js";
import { RiseNative } from "./rise/index.js";
import { MeteoraDlmm } from "./meteora/index.js";

export function createVenues(_conn: Connection, _cfg: Config): { rise: RiseVenue; dlmm: DlmmVenue } {
  // venues do no I/O themselves: the engine feeds them account snapshots via StateSource.update()
  return { rise: new RiseNative(), dlmm: new MeteoraDlmm() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  // pass global fetch so NODE_USE_ENV_PROXY=1 works behind an HTTPS proxy
  const conn = new Connection(cfg.rpcUrl, { commitment: cfg.commitment, fetch: globalThis.fetch });
  const ledger = new Ledger(cfg.ledgerPath);
  const { rise, dlmm } = createVenues(conn, cfg);
  const sender = cfg.mode === "live" ? new RpcSender(conn, { rebroadcastMs: cfg.rebroadcastMs, commitment: cfg.commitment, log: console.log }) : undefined;
  const engine = new ArbEngine({ conn, rise, dlmm, cfg, ledger, sender });

  console.log(`mode=${cfg.mode} user=${cfg.user.toBase58()}${cfg.keypair ? "" : " (no keypair: read-only simulation)"}`);
  console.log(`wSOL ATA ${engine.wsolAta.toBase58()}  RISE ATA ${engine.riseAta.toBase58()}`);
  ledger.append("start", { config: describeConfig(cfg) });

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) { console.log(`${sig} again: exiting now`); process.exit(130); }
    stopping = true;
    console.log(`${sig}: stopping after the current tick${engine.inFlight ? " (waiting for in-flight tx)" : ""}...`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let backoff = 0;
  while (!stopping) {
    const t0 = Date.now();
    try {
      // serialized: the next tick starts only after this one (including any in-flight tx) is done
      await engine.tick();
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
    const wait = Math.max(0, cfg.pollIntervalMs - (Date.now() - t0)) + backoff;
    if (!stopping && wait) await sleep(wait);
  }
  ledger.append("stop", { sessionNetLamports: engine.sessionNetLamports });
  console.log(`stopped. session realized net ${toJson(engine.sessionNetLamports)} lamports`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
