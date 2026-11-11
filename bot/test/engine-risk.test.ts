// Risk limits, halts, e-stop, stale state, upgrade guard, duplicates, one-in-flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { loadConfig, type RiskConfig } from "../src/config.js";
import {
  opportunityKey, parseProgramDataHeader, programDataAddress, ProgramUpgradeGuard, resolveOrphanInFlight, RiskGuard, WATCHED_PROGRAMS, type Halt,
} from "../src/engine/risk.js";
import { run as estop } from "../src/engine/estop.js";
import { Ledger, type Realized } from "../src/engine/ledger.js";
import type { SendResult } from "../src/engine/sender.js";

const DAY1 = Date.parse("2026-11-11T10:00:00Z");
const DAY2 = Date.parse("2026-11-12T00:00:01Z");

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "risk-"));
  const limits: RiskConfig = { ...loadConfig({} as NodeJS.ProcessEnv).risk, statePath: join(dir, "state.json"), killFile: join(dir, "STOP"), pidFile: join(dir, "pid") };
  return { dir, limits, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function guard(limits: RiskConfig, now = () => DAY1, halts: Halt[] = []) {
  return new RiskGuard(limits, { now, log: () => {}, onHalt: (h) => halts.push(h) });
}

let n = 0;
const key = (slot = 100) => ({ signature: `sig${++n}`, messageHash: `msg${n}`, oppKey: `mintThenSell:${n}@${slot}`, slot });
const meta = { lastValidBlockHeight: 1000, feeLamports: 55_000n, tipLamports: 0n, delivery: "rpc" };
const landed = (signature: string, o: Partial<{ success: boolean; fee: bigint; tip: bigint; net: bigint }> = {}) =>
  ({ signature, landed: true, success: o.success ?? true, feeLamports: o.fee ?? 55_000n, tipLamports: o.tip ?? 0n, netLamports: o.net ?? 100_000n });

/** Submit + record one tx. */
function trade(g: RiskGuard, o: Parameters<typeof landed>[1] & { landed?: boolean } = {}) {
  const k = key();
  g.beginSubmission(k, meta);
  return g.recordOutcome(o.landed === false ? { signature: k.signature, landed: false, success: false, feeLamports: 0n, tipLamports: 0n, netLamports: 0n } : landed(k.signature, o));
}

test("config: risk defaults are exactly the operator limits; live still needs 3 opt-ins", () => {
  const c = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.mode, "simulate");
  assert.equal(c.delivery, "rpc");
  assert.equal(c.maxTradeLamports, 100_000_000n);
  assert.deepEqual(
    { ...c.risk, killFile: undefined, statePath: undefined, pidFile: undefined },
    {
      maxInputLamports: 100_000_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n,
      minNetProfitLamports: 100_000n, maxDailyExecCostLamports: 5_000_000n, maxDailyLossLamports: 10_000_000n, maxConsecutiveFailures: 3,
      expiredCountsAsFailure: true, maxStaleSlots: 8, maxStaleMs: 3_000, simMaxAgeMs: 3_000, upgradeCheckMs: 30_000,
      killFile: undefined, statePath: undefined, pidFile: undefined,
    },
  );
  assert.equal(c.risk.killFile, "data/STOP");
  assert.equal(loadConfig({ MAX_TIP_LAMPORTS: "1000", DELIVERY: "jito" } as NodeJS.ProcessEnv).risk.maxTipLamports, 1000n);
  assert.throws(() => loadConfig({ DELIVERY: "carrier-pigeon" } as NodeJS.ProcessEnv), /DELIVERY/);
  // the live A/B delivery is refused without all opt-ins, even in simulate mode
  assert.throws(() => loadConfig({ DELIVERY: "ab" } as NodeJS.ProcessEnv), /MODE=live.*CONFIRM_LIVE=yes.*DELIVERY_COMPARE_LIVE=yes/);
  assert.throws(() => loadConfig({ MODE: "live", DELIVERY: "jito" } as NodeJS.ProcessEnv), /KEYPAIR_PATH/);
});

test("spending limits: input, priority, tip, 10% share, min net, daily headroom", () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    const ok = { direction: "mintThenSell" as const, lamportsIn: 100_000_000n, expectedGrossProfit: 1_000_000n, baseFeeLamports: 5_000n, priorityFeeLamports: 50_000n, tipLamports: 50_000n };
    assert.deepEqual(g.checkTrade(ok), []);
    assert.match(g.checkTrade({ ...ok, lamportsIn: 100_000_001n }).join(), /input 100000001 > max 100000000/);
    assert.match(g.checkTrade({ ...ok, priorityFeeLamports: 50_001n, tipLamports: 0n }).join(), /priority fee 50001 > max 50000/);
    assert.match(g.checkTrade({ ...ok, tipLamports: 50_001n, priorityFeeLamports: 0n }).join(), /tip 50001 > max 50000/);
    // 10%: 100,001 > 10% of 1,000,000
    assert.match(g.checkTrade({ ...ok, priorityFeeLamports: 50_000n, tipLamports: 50_001n }).join(), /priority\+tip 100001 > 1000 bps/);
    // net after base+priority+tip: 200,000 − 5,000 − 20,000 = 175,000 ok; 120,000 − 5,000 − 12,000 = 103,000 ok; 110,000 → 94,000 < 100,000
    assert.deepEqual(g.checkTrade({ ...ok, expectedGrossProfit: 120_000n, priorityFeeLamports: 12_000n, tipLamports: 0n }), []);
    assert.match(g.checkTrade({ ...ok, expectedGrossProfit: 110_000n, priorityFeeLamports: 11_000n, tipLamports: 0n }).join(), /expected net 94000 .* < min 100000/);
    assert.match(g.checkTrade({ ...ok, expectedGrossProfit: 0n, priorityFeeLamports: 0n, tipLamports: 0n }).join(), /bps of expected profit 0/);
  } finally { t.done(); }
});

test("daily execution cost limit trips at 5,000,000 and persists across restart the same UTC day", () => {
  const t = tmp();
  try {
    const halts: Halt[] = [];
    const g = guard(t.limits, () => DAY1, halts);
    // 49 landed txs at 100,000 (fee 50,000 + tip 50,000) = 4,900,000: still trading
    for (let i = 0; i < 49; i++) assert.equal(trade(g, { fee: 50_000n, tip: 50_000n, net: 1_000n }), null);
    assert.equal(g.dailyExecCost, 4_900_000n);
    // pre-trade headroom check: a 105,000 tx would cross the limit
    assert.match(g.checkTrade({ direction: "mintThenSell", lamportsIn: 1n, expectedGrossProfit: 10_000_000n, baseFeeLamports: 5_000n, priorityFeeLamports: 50_000n, tipLamports: 50_000n }).join(), /would exceed 5000000/);
    // a failed landed tx counts too
    const h = trade(g, { success: false, fee: 100_000n, net: -100_000n });
    assert.equal(h?.reason, "daily-exec-cost");
    assert.equal(halts.at(-1)?.reason, "daily-exec-cost");
    // restart, same day: still halted
    assert.equal(guard(t.limits, () => DAY1 + 3_600_000).halt()?.reason, "daily-exec-cost");
    // restart next UTC day: cleared
    const g2 = guard(t.limits, () => DAY2);
    assert.equal(g2.halt(), null);
    assert.equal(g2.dailyExecCost, 0n);
  } finally { t.done(); }
});

test("daily realized loss limit trips at -10,000,000 (costs included, persisted)", () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    assert.equal(trade(g, { net: -6_000_000n }), null);
    assert.equal(trade(g, { net: 1_000_000n }), null);
    const h = trade(g, { net: -5_000_000n });
    assert.equal(h?.reason, "daily-loss");
    assert.equal(g.dailyRealized, -10_000_000n);
    assert.equal(guard(t.limits).halt()?.reason, "daily-loss");
    assert.equal(guard(t.limits, () => DAY2).halt(), null);
  } finally { t.done(); }
});

test("3 consecutive failures halt (expired counts by default); a success resets; persists until cleared", () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    trade(g, { success: false, net: -55_000n });
    trade(g, { success: false, net: -55_000n });
    trade(g, { net: 200_000n });
    assert.equal(g.consecutiveFailures, 0);
    trade(g, { success: false, net: -55_000n });
    trade(g, { landed: false });
    const h = trade(g, { success: false, net: -55_000n });
    assert.equal(h?.reason, "consecutive-failures");
    // survives restart AND the day change (needs operator action)
    assert.equal(guard(t.limits, () => DAY2).halt()?.reason, "consecutive-failures");
    const out: string[] = [];
    estop(["clear-failures"], { RISK_STATE_PATH: t.limits.statePath, PID_FILE: t.limits.pidFile } as NodeJS.ProcessEnv, (m) => out.push(m));
    assert.equal(guard(t.limits).halt(), null);
    // EXPIRED_COUNTS_AS_FAILURE=0: expiries do not count
    const g3 = new RiskGuard({ ...t.limits, expiredCountsAsFailure: false }, { now: () => DAY1, log: () => {} });
    for (let i = 0; i < 5; i++) trade(g3, { landed: false });
    assert.equal(g3.consecutiveFailures, 0);
  } finally { t.done(); }
});

test("e-stop: kill file trips on the next check and stays tripped until removed AND restarted", () => {
  const t = tmp();
  try {
    const halts: Halt[] = [];
    const g = guard(t.limits, () => DAY1, halts);
    assert.equal(g.halt(), null);
    writeFileSync(t.limits.killFile, "operator says stop");
    assert.equal(g.halt()?.reason, "estop-file");
    assert.match(halts[0].detail, /operator says stop/);
    rmSync(t.limits.killFile);
    assert.equal(g.halt()?.reason, "estop-file", "latched for the life of the process");
    assert.throws(() => g.beginSubmission(key(), meta), /halted \(estop-file\)/);
    assert.equal(guard(t.limits).halt(), null, "file removed + restart => clear");
  } finally { t.done(); }
});

test("e-stop: SIGUSR1 latches and writes the kill file; estop.ts writes the file too", async () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    const onSig = () => { g.emergencyStop("SIGUSR1"); };
    process.on("SIGUSR1", onSig);
    try {
      process.kill(process.pid, "SIGUSR1");
      for (let i = 0; i < 50 && !g.halt(); i++) await new Promise((r) => setTimeout(r, 10));
    } finally { process.off("SIGUSR1", onSig); }
    assert.equal(g.halt()?.reason, "estop-signal");
    assert.ok(existsSync(t.limits.killFile), "kill file written so a restart stays stopped");
    assert.equal(guard(t.limits).halt()?.reason, "estop-file");
    rmSync(t.limits.killFile);
    const env = { KILL_FILE: t.limits.killFile, PID_FILE: t.limits.pidFile, RISK_STATE_PATH: t.limits.statePath } as NodeJS.ProcessEnv;
    const out: string[] = [];
    estop(["stop", "drill"], env, (m) => out.push(m));
    assert.match(readFileSync(t.limits.killFile, "utf8"), /drill/);
    assert.equal(guard(t.limits).halt()?.reason, "estop-file");
    estop(["clear"], env, (m) => out.push(m));
    assert.ok(!existsSync(t.limits.killFile));
  } finally { t.done(); }
});

test("stale state: slot lag, data age, provider-reported staleness", () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    g.noteSlot(1_000);
    assert.deepEqual(g.checkFreshness({ snapshotSlot: 992, snapshotReceivedAt: 0, nowPerf: 3_000 }), []);
    assert.match(g.checkFreshness({ snapshotSlot: 991, snapshotReceivedAt: 0, nowPerf: 10 }).join(), /9 slots behind newest seen 1000/);
    assert.match(g.checkFreshness({ snapshotSlot: 1_000, snapshotReceivedAt: 0, nowPerf: 3_001 }).join(), /3001 ms old/);
    assert.match(g.checkFreshness({ snapshotSlot: 1_000, snapshotReceivedAt: 0, nowPerf: 1, providerStale: true }).join(), /provider reports stale/);
  } finally { t.done(); }
});

function pdInfo(deploySlot: bigint, auth: PublicKey | null): AccountInfo<Buffer> {
  const b = Buffer.alloc(45);
  b.writeUInt32LE(3, 0);
  b.writeBigUInt64LE(deploySlot, 4);
  if (auth) { b[12] = 1; auth.toBuffer().copy(b, 13); }
  return { data: b, executable: false, lamports: 1, owner: PublicKey.default, rentEpoch: 0 };
}

test("program-upgrade guard: DLMM + RISE programdata via 45-byte dataSlice; any change halts until restart", async () => {
  const t = tmp();
  try {
    assert.equal(WATCHED_PROGRAMS[1].programData.toBase58(), "HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu"); // Meteora DLMM programdata (mainnet)
    assert.equal(WATCHED_PROGRAMS[0].programData.toBase58(), "2jmivXMvRcbxdsRLqBTwSLWuDgpbAoV9rFbtj5wsXB1E"); // RISE programdata
    assert.ok(programDataAddress(WATCHED_PROGRAMS[1].programId).equals(WATCHED_PROGRAMS[1].programData));
    const auth = PublicKey.unique();
    let dlmmSlot = 423_977_638n;
    const calls: unknown[] = [];
    const conn = {
      async getMultipleAccountsInfo(keys: PublicKey[], cfg: unknown) {
        calls.push(cfg);
        return keys.map((k) => (k.equals(WATCHED_PROGRAMS[1].programData) ? pdInfo(dlmmSlot, auth) : pdInfo(468_145_973n, auth)));
      },
    };
    const halts: Halt[] = [];
    const g = guard(t.limits, () => DAY1, halts);
    const u = new ProgramUpgradeGuard(conn as never, g);
    const base = await u.init();
    assert.match(base["Meteora DLMM"], /deploySlot=423977638/);
    assert.deepEqual((calls[0] as { dataSlice: unknown }).dataSlice, { offset: 0, length: 45 });
    assert.equal(await u.check(), null);
    dlmmSlot++;
    assert.match((await u.check())!, /Meteora DLMM program changed: deploy slot 423977638 -> 423977639/);
    dlmmSlot--;
    assert.equal(g.halt()?.reason, "program-upgrade", "latched even if it changes back");
    assert.equal(halts.length, 1);
    assert.equal(parseProgramDataHeader(pdInfo(5n, null))?.authority, null);
  } finally { t.done(); }
});

test("duplicate protection and exactly one tx in flight (persisted across a crash)", () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    const k = key(200);
    g.beginSubmission(k, meta);
    assert.ok(g.inFlight);
    assert.throws(() => g.beginSubmission(key(200), meta), /already in flight/);
    assert.match(g.checkDuplicate({ ...key(200), oppKey: k.oppKey }).join(), /is in flight/);
    // crash now: a new process must not submit until the orphan is resolved
    const g2 = guard(t.limits);
    assert.equal(g2.orphanInFlight?.signature, k.signature);
    assert.throws(() => g2.beginSubmission(key(), meta), /already in flight/);
    g.recordOutcome(landed(k.signature, { success: false, net: -55_000n }));
    // the same signature / message is never submitted again
    const g3 = guard(t.limits);
    assert.match(g3.checkDuplicate({ ...key(), signature: k.signature }).join(), /signature .* already submitted/);
    assert.match(g3.checkDuplicate({ ...key(), messageHash: k.messageHash }).join(), /message .* already submitted/);
    // identical opportunity that just failed in the same slot is refused; next slot is fine
    assert.match(g.checkDuplicate({ ...key(), oppKey: k.oppKey, slot: 200 }).join(), /just failed in slot 200/);
    assert.deepEqual(g.checkDuplicate({ ...key(), oppKey: k.oppKey, slot: 201 }), []);
    assert.equal(opportunityKey({ direction: "buyThenRedeem", lamportsIn: 5n, rise: 7n, slot: 9 }), "buyThenRedeem:5:7@9");
  } finally { t.done(); }
});

test("startup: an orphaned in-flight tx is resolved (status + getTransaction) and recorded before trading", async () => {
  const t = tmp();
  try {
    const g = guard(t.limits);
    const k = key();
    g.beginSubmission(k, { ...meta, tipLamports: 10_000n });
    const g2 = guard(t.limits);
    const ledger = new Ledger(join(t.dir, "l.jsonl"));
    const realized: Realized = { signature: k.signature, landed: true, success: true, err: null, kind: "mintThenSell", fee: 55_000n, wsolDelta: 400_000n, riseDelta: 3n, nativeDelta: -65_000n, netLamports: 335_000n };
    const resolve = async (_c: unknown, sig: string): Promise<SendResult> => ({ signature: sig, status: "confirmed", slot: 5, broadcasts: 0 });
    const out = await resolveOrphanInFlight({ risk: g2, conn: {} as never, ledger, realize: async () => realized, baseFeeLamports: 5_000n, user: "u", resolve: resolve as never, log: () => {} });
    assert.equal(out?.netLamports, 335_000n);
    assert.equal(g2.orphanInFlight, null);
    assert.equal(g2.dailyExecCost, 65_000n, "fee + measured tip");
    const row = Ledger.read(ledger.path).at(-1)!;
    assert.equal(row.orphan, true);
    assert.deepEqual(row.exec, { base: "5000", priority: "50000", tip: "10000", total: "65000" });
    assert.equal(row.tradingProfit, "400000");
  } finally { t.done(); }
});
