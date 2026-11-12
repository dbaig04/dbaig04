// Collect a sample of transactions for competitor research (read-only, public RPC).
//   npx tsx src/research/collect.ts --out <dir> --address <pk>[,<pk>...] [--max 1000] [--hours 3] [--rps 2]
// Writes <dir>/sigs-<address>.json and <dir>/tx/<sig>.json (getTransaction json, v1).
// Already-fetched txs are skipped, so the script can be re-run to extend a sample.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RateLimitedRpc, signaturesFor, getTxCached, type SigInfo } from "./rpc.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const out = arg("out");
  const addrs = (arg("address") ?? "").split(",").filter(Boolean);
  if (!out || !addrs.length) throw new Error("usage: collect.ts --out <dir> --address <pk>[,..] [--max N] [--hours H] [--rps R] [--sigs-only]");
  const max = Number(arg("max", "1000"));
  const hours = arg("hours");
  const rpc = new RateLimitedRpc({ rps: Number(arg("rps", process.env.RESEARCH_RPS ?? "2")), log: (m) => console.error(m) });
  mkdirSync(out, { recursive: true });
  const untilBlockTime = hours ? Math.floor(Date.now() / 1000 - Number(hours) * 3600) : undefined;
  const all = new Map<string, SigInfo>();
  for (const a of addrs) {
    const f = join(out, `sigs-${a}.json`);
    const prev: SigInfo[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    const sigs = await signaturesFor(rpc, a, { max, untilBlockTime });
    const merged = new Map<string, SigInfo>([...prev, ...sigs].map((s) => [s.signature, s]));
    const list = [...merged.values()].sort((x, y) => y.slot - x.slot);
    writeFileSync(f, JSON.stringify(list));
    console.error(`${a}: ${sigs.length} new-window sigs (${list.length} total), slots ${list.at(-1)?.slot}..${list[0]?.slot}`);
    for (const s of list) all.set(s.signature, s);
  }
  if (process.argv.includes("--sigs-only")) return;
  let n = 0;
  for (const s of all.values()) {
    await getTxCached(rpc, s.signature, join(out, "tx"));
    if (++n % 100 === 0) console.error(`fetched ${n}/${all.size} (requests ${rpc.requests}, throttled ${rpc.throttled})`);
  }
  console.error(`done: ${all.size} txs, ${rpc.requests} requests, ${rpc.throttled} throttled`);
}

main().catch((e) => { console.error(e); process.exit(1); });
