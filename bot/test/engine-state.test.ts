import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { StateManager, TokenBalances, decodeTokenAmount, type StateConnection } from "../src/engine/state.js";
import type { StateSource } from "../src/types.js";
import { tokenAccountInfo, tokenAccountData } from "./engine-fakes.js";

function fakeConn(slotRef: { slot: number }, store: Map<string, AccountInfo<Buffer>>) {
  const calls: { n: number; minContextSlot?: number }[] = [];
  let slotCalls = 0;
  const conn = {
    async getSlot() { slotCalls++; return slotRef.slot; },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[], cfg?: { minContextSlot?: number }) {
      calls.push({ n: keys.length, minContextSlot: cfg?.minContextSlot });
      return { context: { slot: slotRef.slot }, value: keys.map((k) => store.get(k.toBase58()) ?? null) };
    },
  } as unknown as StateConnection;
  return { conn, calls, slotCalls: () => slotCalls };
}

class Src implements StateSource {
  updates: { slot: number; size: number }[] = [];
  extra: PublicKey[] = [];
  constructor(public keys: PublicKey[], private grow?: PublicKey[]) {}
  accounts() { return [...this.keys, ...this.extra]; }
  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>) {
    this.updates.push({ slot, size: infos.size });
    if (this.grow && this.extra.length === 0) this.extra = this.grow;
  }
}

test("one batched fetch per new slot, chunked at 100, deduped union", async () => {
  const keys = Array.from({ length: 230 }, () => PublicKey.unique());
  const a = new Src(keys.slice(0, 150));
  const b = new Src(keys.slice(100)); // overlaps 50
  const slot = { slot: 10 };
  const f = fakeConn(slot, new Map());
  const sm = new StateManager(f.conn, [a, b]);
  const r = await sm.refresh();
  assert.deepEqual(r, { slot: 10, updated: true });
  assert.deepEqual(f.calls.map((c) => c.n), [100, 100, 30]);
  assert.ok(f.calls.every((c) => c.minContextSlot === 10));
  assert.deepEqual(a.updates, [{ slot: 10, size: 230 }]);
  // same slot: no account fetch
  const r2 = await sm.refresh();
  assert.deepEqual(r2, { slot: 10, updated: false });
  assert.equal(f.calls.length, 3);
  slot.slot = 11;
  await sm.refresh();
  assert.equal(f.calls.length, 6);
  assert.equal(b.updates.at(-1)!.slot, 11);
});

test("sources whose accounts() grow after update are refetched in the same tick", async () => {
  const base = [PublicKey.unique()];
  const grown = [PublicKey.unique(), PublicKey.unique()];
  const s = new Src(base, grown);
  const f = fakeConn({ slot: 5 }, new Map());
  const sm = new StateManager(f.conn, [s]);
  await sm.refresh();
  assert.deepEqual(f.calls.map((c) => c.n), [1, 3]);
  assert.deepEqual(s.updates.map((u) => u.size), [1, 3]);
});

test("TokenBalances decodes SPL amounts (and null when missing)", async () => {
  const w = PublicKey.unique(), r = PublicKey.unique();
  const store = new Map([[w.toBase58(), tokenAccountInfo(207_831_356_632n)]]);
  const tb = new TokenBalances(w, r);
  const sm = new StateManager(fakeConn({ slot: 1 }, store).conn, [tb]);
  await sm.refresh();
  assert.equal(tb.wsol, 207_831_356_632n);
  assert.equal(tb.rise, null);
  assert.equal(decodeTokenAmount(tokenAccountData(2n ** 64n - 1n)), 2n ** 64n - 1n);
  assert.throws(() => decodeTokenAmount(Buffer.alloc(10)));
});
