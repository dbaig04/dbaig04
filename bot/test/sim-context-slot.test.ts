// The simulation must never validate a plan on RPC state older than the snapshot it was quoted on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { simulateArb } from "../src/engine/simulate.js";
import { tokenAccountInfo } from "./engine-fakes.js";

const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
const plan = { direction: "buyAsellB", lamportsIn: 1_000_000n, lamportsOut: 1_160_000n } as never;
const base = { wsolAta: PublicKey.default, riseAta: PublicKey.default, wsolPre: 0n, risePre: 0n, profitFloorLamports: 100_000n, toleranceLamports: 20_000n, toleranceBps: 1_000n, feeForUnits: () => ({ cuLimit: 2000, fee: 5_000n }) };
const okValue = { err: null, logs: [], unitsConsumed: 1000, accounts: [acc(160_000n), acc(0n)] };

test("minContextSlot: retries while the RPC reports 'minimum context slot not reached', then simulates at the snapshot slot", async () => {
  let calls = 0; const seen: unknown[] = [];
  const conn = { async simulateTransaction(_tx: unknown, cfg: { minContextSlot?: number }) {
    calls++; seen.push(cfg.minContextSlot);
    if (calls < 3) throw new Error("failed to simulate transaction: Minimum context slot has not been reached");
    return { context: { slot: 101 }, value: okValue };
  } };
  const r = await simulateArb(conn as never, {} as never, plan, { ...base, minContextSlot: 101, slotWaitMs: 1_000, slotWaitPollMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.slot, 101);
  assert.equal(r.rpcBehindRetries, 2);
  assert.deepEqual(seen, [101, 101, 101], "minContextSlot is passed to the RPC");
});

test("minContextSlot: an RPC that ignores it and answers from an older slot is retried, then rejected as 'rpc behind'", async () => {
  let calls = 0;
  const conn = { async simulateTransaction() { calls++; return { context: { slot: 100 }, value: okValue }; } };
  const r = await simulateArb(conn as never, {} as never, plan, { ...base, minContextSlot: 101, slotWaitMs: 30, slotWaitPollMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /rpc behind snapshot slot 101/);
  assert.ok(calls >= 2);
});

test("without minContextSlot behaviour is unchanged", async () => {
  const conn = { async simulateTransaction() { return { context: { slot: 5 }, value: okValue }; } };
  assert.equal((await simulateArb(conn as never, {} as never, plan, base)).ok, true);
});

test("minContextSlot: a generic provider error (e.g. 'ERPC request failed') is retried within the window, then reported with its code", async () => {
  let calls = 0;
  const generic = () => Object.assign(new Error("failed to simulate transaction: ERPC request failed (https://edge.example?api-key=SECRET)"), { code: -32000 });
  const flaky = { async simulateTransaction() { calls++; if (calls < 3) throw generic(); return { context: { slot: 101 }, value: okValue }; } };
  const r = await simulateArb(flaky as never, {} as never, plan, { ...base, minContextSlot: 101, slotWaitMs: 1_000, slotWaitPollMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.rpcErrorRetries, 2);
  assert.ok(!String(r.rpcError).includes("SECRET"), "URL stripped");
  const dead = { async simulateTransaction() { throw generic(); } };
  const r2 = await simulateArb(dead as never, {} as never, plan, { ...base, minContextSlot: 101, slotWaitMs: 20, slotWaitPollMs: 2 });
  assert.equal(r2.ok, false);
  assert.match(r2.reason!, /simulate rpc error: .*ERPC request failed.*\[code -32000\] \(after \d+ retries/);
  assert.ok(!r2.reason!.includes("SECRET"));
});
