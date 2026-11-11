// Report sections (daily + all-time) from a synthetic ledger; per-outcome and startup reconciliation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { breakdown, reconcileBalances, reconcileOutcome, type LedgerEvent, type Realized } from "../src/engine/ledger.js";
import { byUtcDay, ledgerReport, reportSections } from "../src/engine/report.js";

const ev = (ts: string, type: string, x: Record<string, unknown>): LedgerEvent => ({ ts, type: type as LedgerEvent["type"], ...x });
const outcome = (ts: string, o: Record<string, unknown>) => ev(ts, "outcome", { user: "U", ...o });

const LEDGER: LedgerEvent[] = [
  ev("2026-11-10T09:00:00.000Z", "balances", { user: "U", wsol: "1000000000", rise: "0" }),
  // day 1: one ok RPC trade, one landed failure, one dropped
  outcome("2026-11-10T10:00:00.000Z", { landed: true, success: true, fee: "55000", wsolDelta: "400000", riseDelta: "7", nativeDelta: "-55000", netLamports: "345000", riseMarkLamportsPerRiseE9: "1000000000",
    exec: { base: "5000", priority: "50000", tip: "0", total: "55000" }, drift: { wsol: "-10", rise: "0", native: "0" }, delivery: "rpc",
    latencyMs: { decision: 5, built: 6, simulated: 60, sent: 61, landed: 900, slotsToLand: 2 } }),
  outcome("2026-11-10T11:00:00.000Z", { landed: true, success: false, fee: "55000", wsolDelta: "0", riseDelta: "0", nativeDelta: "-55000", netLamports: "-55000", exec: { base: "5000", priority: "50000", tip: "0", total: "55000" }, delivery: "rpc" }),
  outcome("2026-11-10T12:00:00.000Z", { landed: false, success: false, fee: "0", wsolDelta: "0", riseDelta: "0", nativeDelta: "0", netLamports: "0", delivery: "jito" }),
  ev("2026-11-10T12:30:00.000Z", "halt", { reason: "consecutive-failures", detail: "3 consecutive failed txs" }),
  ev("2026-11-10T12:31:00.000Z", "risk", { stage: "pre-send", reasons: ["priority+tip 60000 > 1000 bps of expected profit 500000"] }),
  // day 2: one ok Jito trade with a tip
  outcome("2026-11-11T08:00:00.000Z", { landed: true, success: true, fee: "25000", wsolDelta: "500000", riseDelta: "0", nativeDelta: "-45000", netLamports: "455000", exec: { base: "5000", priority: "20000", tip: "20000", total: "45000" }, drift: { wsol: "0", rise: "0", native: "0" }, delivery: "jito",
    latencyMs: { decision: 4, built: 5, simulated: 50, sent: 52, landed: 700, slotsToLand: 1 } }),
];

test("breakdown separates trading profit, execution costs, failed-attempt costs and RISE residue", () => {
  const b = breakdown(LEDGER.filter((e) => e.type === "outcome"));
  assert.equal(b.submitted, 4);
  assert.equal(b.landed, 3);
  assert.equal(b.succeeded, 2);
  assert.equal(b.failedLanded, 1);
  assert.equal(b.dropped, 1);
  assert.equal(b.tradingProfitLamports, 900_000n, "400,000 + 500,000 (failed trade contributes 0)");
  assert.equal(b.baseFeeLamports, 15_000n);
  assert.equal(b.priorityFeeLamports, 120_000n);
  assert.equal(b.tipLamports, 20_000n);
  assert.equal(b.execCostLamports, 155_000n);
  assert.equal(b.failedCostLamports, 55_000n);
  assert.equal(b.netLamports, 745_000n);
  assert.equal(b.netLamports, b.tradingProfitLamports - b.execCostLamports);
  assert.equal(b.residualRise, 7n, "residue counted separately");
  assert.equal(b.residualRiseValueEstLamports, 7n);
  assert.equal(b.absDrift.wsol, 10n);
});

test("report prints the separate sections per UTC day and all-time", () => {
  assert.deepEqual([...byUtcDay(LEDGER).keys()], ["2026-11-10", "2026-11-11"]);
  const r = ledgerReport(LEDGER);
  const parts = r.split("\n\n");
  assert.equal(parts.length, 3);
  assert.match(parts[0], /==== UTC day 2026-11-10/);
  assert.match(parts[1], /==== UTC day 2026-11-11/);
  assert.match(parts[2], /==== all-time/);
  for (const sec of ["[activity]", "[trading]", "[costs]", "[failed]", "[net]", "[residual]", "[reconcile]", "[latency]", "[halts]", "[delivery]"]) assert.ok(parts[2].includes(sec), sec);
  assert.match(parts[0], /\[trading\]  realized trading profit \(before execution costs\): 0\.000400000 SOL/);
  assert.match(parts[0], /\[failed\]   .*0\.000055000 SOL over 1 txs \(1 dropped at 0\)/);
  assert.match(parts[0], /\[halts\]    1: 12:30:00 consecutive-failures/);
  assert.match(parts[0], /\[risk\]     1 rejections/);
  assert.match(parts[1], /\[costs\]    execution costs: 0\.000045000 SOL = base 0\.000005000 \+ priority 0\.000020000 \+ tip 0\.000020000/);
  assert.match(parts[2], /\[net\]      realized SOL net .*: 0\.000745000 SOL/);
  assert.match(parts[2], /\[residual\] RISE residue \(not in realized SOL\): 7 raw units/);
  assert.match(parts[2], /\[latency\] .*landed 900\/900\/900; slots to land p50 2/);
  assert.match(parts[2], /jito: n=2 landed 1 \(50%\)/);
  assert.match(reportSections([], "empty"), /0 submitted/);
});

test("reconcileOutcome: measured tip, cost split and drift vs the final simulation", () => {
  const ok: Realized = { signature: "s", landed: true, success: true, err: null, kind: "mintThenSell", fee: 25_000n, wsolDelta: 499_990n, riseDelta: 3n, nativeDelta: -45_000n, netLamports: 454_990n };
  const exp = { wsolDelta: 500_000n, riseDelta: 3n, feeLamports: 25_000n, baseFeeLamports: 5_000n, tipLamports: 20_000n };
  const r = reconcileOutcome(ok, exp);
  assert.equal(r.tipLamports, 20_000n);
  assert.equal(r.priorityFeeLamports, 20_000n);
  assert.equal(r.execCostLamports, 45_000n);
  assert.equal(r.tradingProfitLamports, 499_990n);
  assert.deepEqual(r.drift, { wsol: -10n, rise: 0n, native: 0n });
  const failed = reconcileOutcome({ ...ok, success: false, wsolDelta: 0n, riseDelta: 0n, nativeDelta: -25_000n, netLamports: -25_000n }, exp);
  assert.equal(failed.tipLamports, 0n, "tip reverts with the failed tx");
  assert.equal(failed.failedCostLamports, 25_000n);
  assert.equal(failed.tradingProfitLamports, 0n);
  assert.deepEqual(failed.drift, { wsol: 0n, rise: 0n, native: 0n });
  const dropped = reconcileOutcome({ ...ok, landed: false, fee: 0n }, exp);
  assert.equal(dropped.execCostLamports, 0n);
});

test("startup reconcile: on-chain vs last balances snapshot + outcome deltas", () => {
  const r = reconcileBalances(LEDGER, "U", { wsol: 1_000_900_000n, rise: 7n })!;
  assert.equal(r.outcomesSince, 3);
  assert.deepEqual(r.expected, { wsol: 1_000_900_000n, rise: 7n });
  assert.deepEqual(r.drift, { wsol: 0n, rise: 0n });
  const d = reconcileBalances(LEDGER, "U", { wsol: 1_000_000_000n, rise: 0n })!;
  assert.deepEqual(d.drift, { wsol: -900_000n, rise: -7n });
  assert.equal(reconcileBalances(LEDGER, "other", { wsol: 0n, rise: 0n }), null);
});
