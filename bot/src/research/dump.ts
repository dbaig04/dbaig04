// Analyze a directory of saved txs -> JSONL of TxAnalysis (one per tx).
//   npx tsx src/research/dump.ts <txdir> [--tips jito-tips.json] [--program <id>] > out.jsonl
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeTx, type RawTxV1 } from "./analyze.js";
const dir = process.argv[2];
const ti = process.argv.indexOf("--tips");
const tips = ti > 0 ? new Set<string>((JSON.parse(readFileSync(process.argv[ti + 1], "utf8")).result ?? [])) : new Set<string>();
const pi = process.argv.indexOf("--program");
const program = pi > 0 ? process.argv[pi + 1] : undefined;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as RawTxV1;
  if (!t?.meta) continue;
  process.stdout.write(JSON.stringify(analyzeTx(t, { jitoTipAccounts: tips, dataProgram: program })) + "\n");
}
