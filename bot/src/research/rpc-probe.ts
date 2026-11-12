// How far does the simulation RPC trail the processed Geyser stream, and how does it answer a
// simulateTransaction whose minContextSlot it has not reached yet? Read-only (simulate only).
//
//   npx tsx src/research/rpc-probe.ts            (PROBE_SECONDS, default 20)
//
// For each new processed slot announced on the gRPC stream it immediately asks the RPC to simulate a
// trivial transfer with minContextSlot = that slot, retrying every 20 ms until it succeeds (max 2 s).
// Reports: how often the first attempt already succeeds, catch-up time (slot announced -> first
// successful simulation at that slot), and the exact errors returned before that (message + code,
// URLs stripped). Never prints the RPC URL or tokens.
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { makeReadConnection } from "../feeds/index.js";
import { buildSubscribeRequest, yellowstoneConnect, type GeyserUpdate } from "../feeds/grpc.js";
import { describeRpcError } from "../engine/simulate.js";
import { describeRpc, rpcInfo } from "./feed-health.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");

async function main() {
  const cfg = loadConfig();
  const conn = makeReadConnection(cfg);
  console.log(`rpc-probe: RPC ${describeRpc(rpcInfo(cfg))}`);
  if (!cfg.grpc) { console.log("rpc-probe: GRPC_ENDPOINT not set - nothing to compare against"); return; }
  const seconds = Number(process.env.PROBE_SECONDS ?? 20);
  const user = new PublicKey(process.env.SIM_USER ?? "24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU");
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: user, toPubkey: user, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);

  const stream = await yellowstoneConnect(cfg.grpc.endpoint, cfg.grpc.xToken)();
  stream.write(buildSubscribeRequest([], "processed"));
  const announced = new Map<number, number>();
  let newest = -1;
  stream.on("data", (u: GeyserUpdate) => {
    if (u.ping) { stream.write(buildSubscribeRequest([], "processed", 1)); return; }
    if (!u.slot) return;
    const s = Number(u.slot.slot);
    if (!announced.has(s)) announced.set(s, performance.now());
    if (s > newest) newest = s;
  });
  stream.on("error", (e) => console.log(`grpc error: ${describeRpcError(e)}`));

  const catchUp: number[] = [];
  let firstTryOk = 0, probes = 0, gaveUp = 0;
  const errors = new Map<string, number>();
  const ctxLag: number[] = [];
  const end = performance.now() + seconds * 1000;
  let last = -1;
  while (performance.now() < end) {
    if (newest <= last) { await sleep(5); continue; }
    const slot = newest; last = slot;
    const t0 = announced.get(slot) ?? performance.now();
    probes++;
    let tries = 0;
    for (;;) {
      tries++;
      try {
        const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", minContextSlot: slot });
        if (r.context.slot < slot) throw new Error(`returned older context slot ${r.context.slot} < ${slot} (minContextSlot ignored)`);
        catchUp.push(performance.now() - t0);
        ctxLag.push(r.context.slot - slot);
        if (tries === 1) firstTryOk++;
        break;
      } catch (e) {
        const k = describeRpcError(e).slice(0, 140);
        errors.set(k, (errors.get(k) ?? 0) + 1);
        if (performance.now() - t0 > 2_000) { gaveUp++; break; }
        await sleep(20);
      }
    }
  }
  stream.destroy();
  console.log(`rpc-probe: ${probes} processed slots probed over ${seconds}s (gRPC processed slot announced -> RPC simulate with minContextSlot = that slot)`);
  console.log(`  first attempt succeeded: ${firstTryOk}/${probes}; gave up after 2 s: ${gaveUp}`);
  console.log(`  catch-up (slot announced on gRPC -> successful simulation at that slot): median ${f(pct(catchUp, 0.5))} / p95 ${f(pct(catchUp, 0.95))} / max ${f(catchUp.length ? Math.max(...catchUp) : NaN)} ms (n=${catchUp.length})`);
  console.log(`  simulation context slot minus requested slot: median ${f(pct(ctxLag, 0.5))} / max ${f(ctxLag.length ? Math.max(...ctxLag) : NaN)}`);
  if (!errors.size) console.log("  errors before catch-up: none");
  for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) console.log(`  error x${n}: ${k}`);
  process.exit(0);
}

if (process.argv[1]?.endsWith("rpc-probe.ts")) main().catch((e) => { console.error(describeRpcError(e)); process.exit(1); });
