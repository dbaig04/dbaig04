import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileTokenBalances, type LedgerEvent } from "../src/engine/ledger.js";

const ev = (o: Record<string, unknown>) => ({ ts: "2026-11-12T00:00:00Z", ...o }) as unknown as LedgerEvent;

test("reconcile: wSOL is shared across pairs, token balances are reconciled per pair (RISE and MAX separately)", () => {
  const evs = [
    ev({ type: "balances", user: "U", wsol: "1000000", tokens: { rise: "50", max: "7" } }),
    ev({ type: "outcome", landed: true, user: "U", wsolDelta: "100", riseDelta: "3" }),               // RISE engine (no pair field)
    ev({ type: "outcome", landed: true, user: "U", pair: "max", wsolDelta: "200", riseDelta: "5" }), // MAX
    ev({ type: "outcome", landed: false, user: "U", pair: "max", wsolDelta: "999", riseDelta: "999" }), // dropped: ignored
    ev({ type: "outcome", landed: true, user: "Other", pair: "max", wsolDelta: "999", riseDelta: "999" }), // other user: ignored
  ];
  const r = reconcileTokenBalances(evs, "U", { wsol: 1_000_300n, tokens: { rise: 53n, max: 13n } })!;
  assert.equal(r.expected.wsol, 1_000_300n);
  assert.deepEqual(r.expected.tokens, { rise: 53n, max: 12n });
  assert.equal(r.drift.wsol, 0n);
  assert.deepEqual(r.drift.tokens, { rise: 0n, max: 1n }, "MAX drift detected on the MAX account only");
  assert.equal(r.outcomesSince, 2);
});

test("reconcile: legacy snapshot with only `rise` still works; a pair without baseline is reported, not guessed", () => {
  const evs = [ev({ type: "balances", user: "U", wsol: "10", rise: "4" }), ev({ type: "outcome", landed: true, user: "U", pair: "max", wsolDelta: "1", riseDelta: "2" })];
  const r = reconcileTokenBalances(evs, "U", { wsol: 11n, tokens: { rise: 4n, max: 2n } })!;
  assert.deepEqual(r.drift.tokens, { rise: 0n });
  assert.deepEqual(r.noBaseline, ["max"]);
  assert.equal(r.drift.wsol, 0n);
  assert.equal(reconcileTokenBalances([], "U", { wsol: 0n, tokens: {} }), null);
});
