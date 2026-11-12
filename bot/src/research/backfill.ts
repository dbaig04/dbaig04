// After a shadow run: classify every saved pool tx (run watcher + post-hoc backfill dirs) into MAX
// round trips per route and write <shadow dir>/competitors.jsonl (deduped, slot-ordered), plus the slot
// coverage of each pool's signatures that were actually fetched (contiguous, newest-first collection).
//   npx tsx src/research/backfill.ts <shadow dir> <tx dir>... [--sigs <sigs json>...]
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeTx, type RawTxV1 } from "./analyze.js";
import { maxArbAnyRoute } from "./competitors.js";
import { MAX_DLMM_POOLS, MAX_PUMPSWAP_POOL } from "../engine/pair-venues.js";

const [shadowDir, ...rest] = process.argv.slice(2);
const si = rest.indexOf("--sigs");
const txDirs = si >= 0 ? rest.slice(0, si) : rest;
const sigFiles = si >= 0 ? rest.slice(si + 1) : [];
const seen = new Set<string>();
const arbs: unknown[] = [];
const fetched = new Set<string>();
for (const d of txDirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const sig = f.slice(0, -5);
    fetched.add(sig);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const t = JSON.parse(readFileSync(join(d, f), "utf8")) as RawTxV1 | null;
    if (!t?.meta) continue;
    const a = maxArbAnyRoute(analyzeTx(t), MAX_PUMPSWAP_POOL, MAX_DLMM_POOLS);
    if (a) arbs.push({ ...a, fetchedAt: 0 });
  }
}
(arbs as { slot: number }[]).sort((x, y) => x.slot - y.slot);
const out = join(shadowDir, "competitors.jsonl");
if (existsSync(out) && !existsSync(out + ".run")) copyFileSync(out, out + ".run");
writeFileSync(out, arbs.map((x) => JSON.stringify(x)).join("\n") + (arbs.length ? "\n" : ""));
// coverage: for each sig list (newest first), the slot range of the newest-first prefix that was fetched
for (const f of sigFiles) {
  const sigs = JSON.parse(readFileSync(f, "utf8")) as { signature: string; slot: number }[];
  let i = 0;
  while (i < sigs.length && fetched.has(sigs[i].signature)) i++;
  const covered = i ? [sigs[i - 1].slot, sigs[0].slot] : null;
  console.log(`${f.split("/").pop()}: ${sigs.length} sigs (slots ${sigs.at(-1)?.slot}..${sigs[0]?.slot}); fully fetched newest-first prefix: ${i} sigs, slots ${covered ? `${covered[0]}..${covered[1]}` : "none"}; any fetched: ${sigs.filter((s) => fetched.has(s.signature)).length}`);
}
console.log(`${arbs.length} MAX round trips -> ${out}`);
