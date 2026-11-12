// Record a mainnet state snapshot of the MAX pair venues (every account their accounts() asks
// for, at one context slot) to a small gzip JSON fixture for replay tests.
//   NODE_USE_ENV_PROXY=1 npx tsx src/research/record-fixture.ts [--out test/fixtures/pair] [--count 1] [--gap-ms 20000]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Connection, type AccountInfo, type PublicKey } from "@solana/web3.js";
import { keepAliveFetch } from "../feeds/http.js";
import { StateManager } from "../engine/state.js";
import { maxPairSpec } from "../engine/pair-venues.js";

export interface PairFixture {
  pair: string;
  slot: number;
  recordedAt: string;
  accounts: Record<string, { owner: string; lamports: number; executable: boolean; data: string } | null>;
}

export function encodeInfos(infos: Map<string, AccountInfo<Buffer> | null>): PairFixture["accounts"] {
  const out: PairFixture["accounts"] = {};
  for (const [k, v] of infos) out[k] = v ? { owner: v.owner.toBase58(), lamports: v.lamports, executable: v.executable, data: v.data.toString("base64") } : null;
  return out;
}

async function main() {
  const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg("out", "test/fixtures/pair");
  const count = Number(arg("count", "1"));
  const gap = Number(arg("gap-ms", "20000"));
  mkdirSync(out, { recursive: true });
  const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", fetch: keepAliveFetch() });
  for (let i = 0; i < count; i++) {
    const { pumpswap, dlmmVenues } = maxPairSpec({ ...process.env, MAX_DLMM_POOLS: undefined, MAX_DLMM_POOL: undefined });
    let last: Map<string, AccountInfo<Buffer> | null> = new Map();
    // capture what the StateManager fetched (it refetches the whole union when a source's set grows)
    const rec = {
      getSlot: (c?: never) => conn.getSlot(c),
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[], cfg?: never) => {
        const r = await conn.getMultipleAccountsInfoAndContext(keys, cfg);
        keys.forEach((k, j) => last.set(k.toBase58(), (r.value[j] as AccountInfo<Buffer> | null) ?? null));
        return r;
      },
    };
    const sm = new StateManager(rec as never, [pumpswap, ...dlmmVenues], "confirmed");
    last = new Map();
    const { slot } = await sm.refresh();
    if (!pumpswap.ready() || dlmmVenues.some((d) => !d.ready())) throw new Error("venues not ready after refresh");
    const wanted = new Set(sm.wantedAccounts().map((k) => k.toBase58()));
    const accounts = new Map([...last].filter(([k]) => wanted.has(k)));
    const fx: PairFixture = { pair: "max", slot, recordedAt: new Date().toISOString(), accounts: encodeInfos(accounts) };
    const gz = gzipSync(Buffer.from(JSON.stringify(fx)), { level: 9 });
    const f = join(out, `max3-${slot}.json.gz`);
    writeFileSync(f, gz);
    console.log(`${f}: ${accounts.size} accounts, ${gz.length} bytes gz; pumpswap price ${pumpswap.spotPrice().toExponential(4)} lamports/unit`);
    if (i + 1 < count) await new Promise((r) => setTimeout(r, gap));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
