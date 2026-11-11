import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { StateManager, type StateConnection } from "../src/engine/state.js";
import { AccountStore, GrpcProvider, buildSubscribeRequest, decodeAccountUpdate, SYSVAR_CLOCK, type GeyserUpdate } from "../src/feeds/grpc.js";
import { ChangeSignal } from "../src/feeds/signal.js";
import type { StateSource } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OWNER = PublicKey.unique();

class FakeStream extends EventEmitter {
  writes: Record<string, unknown>[] = [];
  destroyed = false;
  write(req: unknown, cb?: (e?: Error | null) => void) { this.writes.push(req as Record<string, unknown>); cb?.(null); return true; }
  destroy() { this.destroyed = true; }
  push(u: GeyserUpdate) { this.emit("data", u); }
}

function rpc(slotRef: { slot: number }, store: Map<string, AccountInfo<Buffer>>) {
  const calls: string[][] = [];
  const conn = {
    async getSlot() { return slotRef.slot; },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      calls.push(keys.map((k) => k.toBase58()));
      return { context: { slot: slotRef.slot }, value: keys.map((k) => store.get(k.toBase58()) ?? null) };
    },
  } as unknown as StateConnection;
  return { conn, calls };
}

const info = (byte: number, lamports = 1): AccountInfo<Buffer> => ({ data: Buffer.from([byte]), executable: false, lamports, owner: OWNER, rentEpoch: 0 });

function upd(key: PublicKey, slot: number, wv: number, byte: number, lamports = 1): GeyserUpdate {
  return { account: { slot: String(slot), account: { pubkey: key.toBytes(), lamports: String(lamports), owner: OWNER.toBytes(), executable: false, rentEpoch: "0", data: Uint8Array.from([byte]), writeVersion: String(wv) } } };
}
const slotMsg = (slot: number): GeyserUpdate => ({ slot: { slot: String(slot), status: 1 } });

class Src implements StateSource {
  updates: { slot: number; data: Record<string, number | null> }[] = [];
  extra: PublicKey[] = [];
  constructor(public keys: PublicKey[], private grow?: PublicKey[]) {}
  accounts() { return [...this.keys, ...this.extra]; }
  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>) {
    this.updates.push({ slot, data: Object.fromEntries([...infos].map(([k, v]) => [k, v ? v.data[0] : null])) });
    if (this.grow && this.extra.length === 0) this.extra = this.grow;
  }
}

function setup(opts: { keys: PublicKey[]; grow?: PublicKey[]; store?: Map<string, AccountInfo<Buffer>>; now?: () => number; staleMs?: number; failFirst?: number }) {
  const slotRef = { slot: 100 };
  const store = opts.store ?? new Map(opts.keys.map((k, i) => [k.toBase58(), info(i + 1)]));
  const r = rpc(slotRef, store);
  const src = new Src(opts.keys, opts.grow);
  const poller = new StateManager(r.conn, [src]);
  const streams: FakeStream[] = [];
  let fails = opts.failFirst ?? 0;
  const signal = new ChangeSignal();
  const logs: string[] = [];
  const p = new GrpcProvider(poller, {
    connect: async () => {
      if (fails-- > 0) throw new Error("connection refused");
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    commitment: "confirmed", debounceMs: 5, reconnectMinMs: 5, reconnectMaxMs: 20, staleMs: opts.staleMs ?? 1000, pingMs: 60_000,
    signal, log: (m) => logs.push(m), now: opts.now,
  });
  return { p, src, streams, r, slotRef, store, signal, logs };
}

test("AccountStore orders by (slot, write_version); seeds never override same-or-newer stream data", () => {
  const s = new AccountStore();
  assert.ok(s.applyStream("A", 10, 5n, 1, info(1), 0));
  assert.equal(s.applyStream("A", 9, 99n, 1, info(2), 0), false, "older slot rejected");
  assert.equal(s.applyStream("A", 10, 4n, 1, info(3), 0), false, "older write_version rejected");
  assert.equal(s.applyStream("A", 10, 5n, 1, info(3), 0), false, "duplicate rejected");
  assert.ok(s.applyStream("A", 10, 6n, 1, info(4), 0));
  assert.equal(s.applySeed("A", 10, 1, info(5), 0), false, "seed at same slot loses to stream");
  assert.ok(s.applySeed("A", 11, 1, info(6), 0));
  assert.ok(s.applyStream("A", 11, 1n, 2, info(7), 0), "same slot from a newer connection generation wins");
  assert.equal(s.map.get("A")!.info!.data[0], 7);
  assert.equal(s.rejected, 4);
});

test("decodeAccountUpdate: bytes -> AccountInfo; zero lamports -> null (closed)", () => {
  const k = PublicKey.unique();
  const d = decodeAccountUpdate(upd(k, 7, 3, 42).account!)!;
  assert.equal(d.key, k.toBase58());
  assert.equal(d.slot, 7);
  assert.equal(d.writeVersion, 3n);
  assert.equal(d.info!.data[0], 42);
  assert.ok(d.info!.owner.equals(OWNER));
  assert.equal(decodeAccountUpdate(upd(k, 7, 4, 0, 0).account!)!.info, null);
});

test("subscribe request: accounts + slots at commitment; ping variant keeps filters", () => {
  const r = buildSubscribeRequest(["b", "a"], "processed") as { accounts: { bot: { account: string[] } }; commitment: number; slots: object; ping?: unknown };
  assert.deepEqual(r.accounts.bot.account, ["a", "b"]);
  assert.equal(r.commitment, 0);
  assert.deepEqual(r.slots, { bot: { filterByCommitment: true } });
  const p = buildSubscribeRequest(["a"], "confirmed", 7) as { ping: { id: number }; accounts: object; commitment: number };
  assert.deepEqual(p.ping, { id: 7 });
  assert.equal(p.commitment, 1);
  assert.ok("bot" in p.accounts);
});

test("polls RPC until seeded, then serves the stream store event-driven (debounced per slot)", async () => {
  const [a, b] = [PublicKey.unique(), PublicKey.unique()];
  const t = setup({ keys: [a, b] });
  // before start: not healthy -> RPC poll fallback
  const r0 = await t.p.refresh();
  assert.equal(r0.updated, true);
  assert.equal(t.p.lastSource, "grpc-fallback-rpc");
  t.p.start();
  await sleep(10);
  assert.equal(t.streams.length, 1);
  const req = t.streams[0].writes[0] as { accounts: { bot: { account: string[] } } };
  assert.deepEqual(req.accounts.bot.account.sort(), [a.toBase58(), b.toBase58()].sort());
  assert.equal(t.p.seeded, true);
  assert.ok(t.p.healthy());
  // seed snapshot is served from the store, no extra RPC account fetch
  const before = t.r.calls.length;
  const r1 = await t.p.refresh();
  assert.deepEqual(r1, { slot: 100, updated: true });
  assert.equal(t.p.lastSource, "grpc");
  assert.equal(t.r.calls.length, before);
  assert.equal((await t.p.refresh()).updated, false, "no change -> no update");
  assert.equal(await t.signal.wait(0), "grpc-seed", "seeding signalled the loop");
  // two updates in slot 101 -> one notify after the slot status
  const n0 = t.signal.notifies;
  t.streams[0].push(upd(a, 101, 10, 50));
  t.streams[0].push(upd(b, 101, 11, 60));
  assert.equal(t.signal.notifies, n0);
  t.streams[0].push(slotMsg(101));
  assert.equal(t.signal.notifies, n0 + 1);
  assert.equal(await t.signal.wait(0), "grpc");
  const r2 = await t.p.refresh();
  assert.deepEqual(r2, { slot: 101, updated: true });
  assert.deepEqual(t.src.updates.at(-1), { slot: 101, data: { [a.toBase58()]: 50, [b.toBase58()]: 60 } });
  // stale (older) update is ignored and does not signal
  t.streams[0].push(upd(a, 100, 99, 1));
  t.streams[0].push(slotMsg(102));
  assert.equal((await t.p.refresh()).updated, false);
  // without a slot status the debounce timer flushes
  t.streams[0].push(upd(a, 103, 12, 70));
  await sleep(15);
  assert.equal(t.signal.notifies, n0 + 2);
  assert.equal((await t.p.refresh()).slot, 103);
  assert.equal(t.src.updates.at(-1)!.data[a.toBase58()], 70);
  // an update in a later slot flushes the earlier dirty slot immediately
  t.streams[0].push(upd(a, 104, 13, 71));
  t.streams[0].push(upd(b, 105, 14, 72));
  assert.equal(t.signal.notifies, n0 + 3);
  t.p.close();
});

test("quiet accounts (Clock sysvar) are stored but do not trigger re-evaluation", async () => {
  const clock = new PublicKey(SYSVAR_CLOCK);
  const a = PublicKey.unique();
  const t = setup({ keys: [a, clock] });
  t.p.start();
  await sleep(10);
  await t.p.refresh();
  const n0 = t.signal.notifies;
  t.streams[0].push(upd(clock, 101, 1, 9));
  t.streams[0].push(slotMsg(101));
  await sleep(10);
  assert.equal(t.signal.notifies, n0);
  assert.equal(t.p.store.map.get(SYSVAR_CLOCK)!.info!.data[0], 9);
  t.p.close();
});

test("reconnects with backoff after errors, resubscribes and re-seeds; polls meanwhile", async () => {
  const a = PublicKey.unique();
  const t = setup({ keys: [a], failFirst: 2 });
  t.p.start();
  await sleep(80);
  assert.equal(t.streams.length, 1, "connected after two failed attempts");
  assert.ok(t.p.reconnects >= 2);
  assert.ok(t.p.healthy());
  await t.p.refresh();
  t.streams[0].emit("error", new Error("RST_STREAM"));
  assert.equal(t.p.healthy(), false);
  assert.ok(t.streams[0].destroyed);
  const polls = t.r.calls.length;
  t.slotRef.slot = 120;
  const r = await t.p.refresh();
  assert.equal(t.p.lastSource, "grpc-fallback-rpc");
  assert.equal(r.slot, 120);
  assert.ok(t.r.calls.length > polls);
  await sleep(40);
  assert.equal(t.streams.length, 2, "new stream");
  assert.ok(t.streams[1].writes.length >= 1, "resubscribed on the new stream");
  assert.ok(t.p.healthy(), "re-seeded");
  // updates from the dead stream are ignored
  t.streams[0].push(upd(a, 999, 1, 1));
  assert.notEqual(t.p.store.map.get(a.toBase58())!.slot, 999);
  t.p.close();
});

test("staleness: no message for staleMs -> not healthy -> RPC poll; recovers on next message", async () => {
  let now = 0;
  const a = PublicKey.unique();
  const t = setup({ keys: [a], now: () => now, staleMs: 500 });
  t.p.start();
  await sleep(10);
  assert.ok(t.p.healthy());
  await t.p.refresh();
  now = 600;
  assert.equal(t.p.healthy(), false);
  await t.p.refresh();
  assert.equal(t.p.lastSource, "grpc-fallback-rpc");
  t.streams[0].push(slotMsg(130));
  assert.ok(t.p.healthy());
  const r = await t.p.refresh();
  assert.equal(r.updated, true);
  assert.equal(t.p.lastSource, "grpc");
  t.p.close();
});

test("account-set growth (bin arrays): resubscribe on the live stream and seed the new accounts", async () => {
  const a = PublicKey.unique();
  const grown = [PublicKey.unique(), PublicKey.unique()];
  const store = new Map([[a.toBase58(), info(1)], [grown[0].toBase58(), info(2)], [grown[1].toBase58(), info(3)]]);
  const t = setup({ keys: [a], grow: grown, store });
  t.p.start();
  await sleep(10);
  const writes0 = t.streams[0].writes.length;
  await t.p.refresh();
  const last = t.streams[0].writes.at(-1) as { accounts: { bot: { account: string[] } } };
  assert.equal(t.streams[0].writes.length, writes0 + 1);
  assert.deepEqual(last.accounts.bot.account.sort(), [a, ...grown].map((k) => k.toBase58()).sort());
  // the same refresh fed the grown set (seeded via RPC)
  const u = t.src.updates.at(-1)!;
  assert.equal(u.data[grown[0].toBase58()], 2);
  assert.equal(u.data[grown[1].toBase58()], 3);
  assert.deepEqual(t.r.calls.at(-1)!.sort(), grown.map((k) => k.toBase58()).sort());
  // and their stream updates are accepted afterwards
  t.streams[0].push(upd(grown[1], 101, 5, 33));
  t.streams[0].push(slotMsg(101));
  await t.p.refresh();
  assert.equal(t.src.updates.at(-1)!.data[grown[1].toBase58()], 33);
  t.p.close();
});

test("server ping is answered with a ping carrying the same filters", async () => {
  const a = PublicKey.unique();
  const t = setup({ keys: [a] });
  t.p.start();
  await sleep(10);
  t.streams[0].push({ ping: {} });
  const w = t.streams[0].writes.at(-1) as { ping?: { id: number }; accounts: { bot: { account: string[] } } };
  assert.ok(w.ping);
  assert.deepEqual(w.accounts.bot.account, [a.toBase58()]);
  t.p.close();
});

test("ChangeSignal coalesces notifies and times out", async () => {
  const s = new ChangeSignal();
  s.notify("x"); s.notify("y");
  assert.equal(await s.wait(1000), "x");
  assert.equal(await s.wait(5), "timeout");
  const w = s.wait(1000);
  s.notify("z");
  assert.equal(await w, "z");
});
