// Rebuild the final SHADOW.md from a finished shadow run's files (ticks.jsonl + competitors.jsonl).
//   npx tsx src/research/shadow-final.ts <shadow dir> [--md src/research/SHADOW.md] [--scanned N] [--notes-file f]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairTickInfo } from "../engine/pair-engine.js";
import type { CompetitorArb } from "./competitors.js";
import { compare, renderShadowMd, summarizeTicks } from "./shadow-report.js";
import { untakenLines } from "./shadow-run.js";

const dir = process.argv[2];
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ticks = lines(join(dir, "ticks.jsonl")) as PairTickInfo[];
const arbs = lines(join(dir, "competitors.jsonl")) as CompetitorArb[];
const minutes = ticks.length ? (ticks[ticks.length - 1].wallStart - ticks[0].wallStart) / 60_000 : 0;
const extra = arg("notes-file") && existsSync(arg("notes-file")!) ? readFileSync(arg("notes-file")!, "utf8").split("\n") : [];
const md = renderShadowMd({
  title: "MAX shadow run (PumpSwap ⇄ Meteora DLMM)", startedAt: new Date(ticks[0]?.wallStart ?? 0).toISOString(), minutes, interim: false,
  summary: summarizeTicks(ticks), comparisons: compare(ticks, arbs), competitorTxsScanned: Number(arg("scanned") ?? 0),
  notes: [...untakenLines(ticks, arbs), ...extra],
});
writeFileSync(arg("md") ?? "src/research/SHADOW.md", md);
console.log(`wrote ${arg("md") ?? "src/research/SHADOW.md"}: ${ticks.length} ticks, ${arbs.length} competitor arbs`);
