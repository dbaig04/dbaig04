import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTx, droppedOutcome, Ledger, outcomeFromEvent, summarize, type RawTx } from "../src/engine/ledger.js";
import { analyzeReferenceDir, referenceRiseMark, userAtas } from "../src/engine/report.js";
import { REFERENCE_WALLET } from "../src/config.js";

const FIX = join(import.meta.dirname, "fixtures", "engine");
const load = (prefix: string): RawTx => {
  const f = readdirSync(FIX).find((x) => x.startsWith(prefix))!;
  return JSON.parse(readFileSync(join(FIX, f), "utf8")).result;
};
const { wsolAta, riseAta } = userAtas(REFERENCE_WALLET);

test("reference ATAs derive with the right token programs", () => {
  assert.equal(wsolAta, "FrAqBUnCz8z7Sm7GVh4moJJEbGcoBinUM5BxSAAfvE7o");
  assert.equal(riseAta, "BKxadbyMKTTY4drGmv9cxvoFpWSaCVoLDu6g9D77Vmhq");
});

test("realized numbers from a landed mintThenSell", () => {
  const r = analyzeTx(load("21Z1FdCTb"), REFERENCE_WALLET, wsolAta, riseAta);
  assert.equal(r.kind, "mintThenSell");
  assert.equal(r.success, true);
  assert.equal(r.fee, 55_001n);
  assert.equal(r.nativeDelta, -55_001n);
  assert.equal(r.wsolDelta, 207_834_441_136n - 207_831_356_632n);
  assert.equal(r.riseDelta, 77_898_203_516n - 77_694_409_914n);
  assert.equal(r.netLamports, 3_084_504n - 55_001n);
  // mark from the Buy args: lamports_in / min_rise_out
  assert.equal(referenceRiseMark(load("21Z1FdCTb")), (523_999_059n * 1_000_000_000n) / 858_078_326_245n);
});

test("realized numbers from a landed buyThenRedeem", () => {
  const r = analyzeTx(load("23QRS8ByH"), REFERENCE_WALLET, wsolAta, riseAta);
  assert.equal(r.kind, "buyThenRedeem");
  assert.equal(r.wsolDelta, 2_876_049n);
  assert.equal(r.riseDelta, 0n);
  assert.equal(r.netLamports, 2_876_049n - 55_001n);
});

test("failed-but-landed txs cost exactly their fee", () => {
  for (const p of ["5EALs6gLz", "qnrT34umJ"]) {
    const r = analyzeTx(load(p), REFERENCE_WALLET, wsolAta, riseAta);
    assert.equal(r.success, false);
    assert.equal(r.wsolDelta, 0n);
    assert.equal(r.riseDelta, 0n);
    assert.equal(r.netLamports, -55_001n);
  }
});

test("summary: gross, fees, failed costs, net, win rate; dropped count as 0", () => {
  const outs = ["21Z1FdCTb", "23QRS8ByH", "5EALs6gLz", "qnrT34umJ"].map((p) => analyzeTx(load(p), REFERENCE_WALLET, wsolAta, riseAta));
  outs.push(droppedOutcome("x", "mintThenSell"));
  const s = summarize(outs);
  assert.equal(s.submitted, 5);
  assert.equal(s.landed, 4);
  assert.equal(s.dropped, 1);
  assert.equal(s.succeeded, 2);
  assert.equal(s.failedLanded, 2);
  assert.equal(s.grossLamports, 3_084_504n + 2_876_049n);
  assert.equal(s.feesLamports, 4n * 55_001n);
  assert.equal(s.failedCostLamports, 2n * 55_001n);
  assert.equal(s.netLamports, s.grossLamports - s.feesLamports);
  assert.equal(s.winRate, 0.5);
});

test("ledger JSONL roundtrip keeps bigints exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const l = new Ledger(join(dir, "sub", "l.jsonl"));
    const r = analyzeTx(load("21Z1FdCTb"), REFERENCE_WALLET, wsolAta, riseAta);
    l.append("outcome", { ...r, riseMarkLamportsPerRiseE9: 610_000n });
    l.append("simulation", { ok: true, simulatedProfit: 123n });
    const evs = Ledger.read(l.path);
    assert.equal(evs.length, 2);
    const back = outcomeFromEvent(evs[0]);
    assert.equal(back.netLamports, r.netLamports);
    assert.equal(back.riseDelta, r.riseDelta);
    assert.equal(back.riseMarkLamportsPerRiseE9, 610_000n);
    assert.equal(evs[1].simulatedProfit, "123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reference-dir backfill separates arb from other txs", () => {
  const { arb, other, skipped } = analyzeReferenceDir(FIX, REFERENCE_WALLET);
  assert.equal(arb.length, 4);
  assert.equal(other.length, 0);
  assert.equal(skipped, 0);
  assert.ok(arb.find((a) => a.kind === "mintThenSell" && a.success)!.riseMarkLamportsPerRiseE9! > 0n);
});
