import { test } from "node:test";
import assert from "node:assert/strict";
import { pairFailures } from "../src/research/sim-diag.js";

const r = (o: Record<string, unknown>) => ({ ts: "2026-11-12T09:00:00.000Z", ...o }) as never;

test("sim-diag pairs each failed non-forced simulation with its opportunity (snapshot slot vs sim slot)", () => {
  const rows = [
    r({ type: "opportunity", slot: 100, plan: { pair: "max:6PkALv", direction: "buyBsellA", expectedProfit: "250000" } }),
    r({ type: "simulation", ts: "2026-11-12T09:00:00.040Z", slot: 101, stage: "pre", forced: false, ok: false, direction: "buyBsellA", reason: "sim error 6004" }),
    r({ type: "simulation", slot: 105, stage: "pre", forced: true, ok: false, direction: "buyBsellA", reason: "forced probe" }), // ignored
    r({ type: "opportunity", slot: 200, plan: { pair: "max:5nwdWt", direction: "buyAsellB", expectedProfit: "758162" } }),
    r({ type: "simulation", slot: 999, snapshotSlot: 200, simSlot: 202, stage: "pre", forced: false, ok: false, direction: "buyAsellB", reason: "sim error 6003" }),
    r({ type: "simulation", slot: 300, stage: "pre", forced: false, ok: false, direction: "buyAsellB", reason: "no opportunity row" }), // unpaired: ignored
  ];
  const f = pairFailures(rows);
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].route, f[0].snapSlot, f[0].simSlot, f[0].ms], ["max:6PkALv", 100, 101, 40]);
  assert.deepEqual([f[1].route, f[1].snapSlot, f[1].simSlot], ["max:5nwdWt", 200, 202], "explicit snapshotSlot/simSlot win");
});
