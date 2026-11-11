import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair, MessageV0, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, ComputeBudgetProgram } from "@solana/web3.js";
import {
  classifyPayload, classifyTx, decodeEntries, decodeEntryMessage, defaultWatchSet, dlmmReserve, encodeSubscribeEntriesRequest,
  PendingActivity, ShredFeed, type LookupResolver,
} from "../src/feeds/shreds.js";
import { ChangeSignal } from "../src/feeds/signal.js";
import { DLMM_PROGRAM_ID, POOL_ADDRESS, RISE_MINT, RISE_PROGRAM_ID, WSOL_MINT } from "../src/types.js";

// ---------- hand-rolled bincode / ledger-wire builders (independent of the decoder) ----------
const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const shortVec = (n: number) => { const out: number[] = []; let v = n; for (;;) { const b = v & 0x7f; v >>= 7; if (v) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); };
const key = (k: string | PublicKey) => (typeof k === "string" ? new PublicKey(k) : k).toBuffer();
const sig = (fill: number) => Buffer.alloc(64, fill);

/** Legacy tx bytes, built by hand: short_vec sigs, header, short_vec keys, blockhash, short_vec ixs. */
function legacyTx(sigFill: number, keys: (string | PublicKey)[], ixs: { p: number; a: number[]; d: number[] }[]) {
  return Buffer.concat([
    shortVec(1), sig(sigFill),
    Buffer.from([1, 0, 1]),
    shortVec(keys.length), ...keys.map(key),
    Buffer.alloc(32, 9),
    shortVec(ixs.length), ...ixs.map((ix) => Buffer.concat([Buffer.from([ix.p]), shortVec(ix.a.length), Buffer.from(ix.a), shortVec(ix.d.length), Buffer.from(ix.d)])),
  ]);
}

/** v1 (SIMD-0385) tx bytes: 0x81, header, mask, lifetime, #ix, #addr, addrs, config, ix headers, payloads, sigs. */
function v1Tx(sigFill: number, keys: (string | PublicKey)[], ixs: { p: number; a: number[]; d: number[] }[], cfg: { priorityFee?: bigint; cuLimit?: number }) {
  let mask = 0;
  const vals: Buffer[] = [];
  if (cfg.priorityFee !== undefined) { mask |= 0b11; vals.push(u64(cfg.priorityFee)); }
  if (cfg.cuLimit !== undefined) { mask |= 0b100; vals.push(u32(cfg.cuLimit)); }
  return Buffer.concat([
    Buffer.from([0x81, 1, 0, 1]), u32(mask), Buffer.alloc(32, 7), Buffer.from([ixs.length, keys.length]), ...keys.map(key), ...vals,
    ...ixs.map((ix) => Buffer.concat([Buffer.from([ix.p, ix.a.length]), u16(ix.d.length)])),
    ...ixs.map((ix) => Buffer.concat([Buffer.from(ix.a), Buffer.from(ix.d)])),
    sig(sigFill),
  ]);
}

const entry = (numHashes: number, hashFill: number, txs: Buffer[]) => Buffer.concat([u64(numHashes), Buffer.alloc(32, hashFill), u64(txs.length), ...txs]);
const entries = (es: Buffer[]) => Buffer.concat([u64(es.length), ...es]);
/** protobuf shredstream.Entry { uint64 slot = 1; bytes entries = 2; } */
function pbEntry(slot: number, payload: Buffer) {
  const varint = (n: number) => { const out: number[] = []; let v = BigInt(n); while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; } out.push(Number(v)); return out; };
  return Buffer.from([0x08, ...varint(slot), 0x12, ...varint(payload.length), ...payload]);
}

const COMPETITOR = Keypair.generate().publicKey;
const OTHER_PROG = Keypair.generate().publicKey;
const reserveX = dlmmReserve(POOL_ADDRESS, RISE_MINT);

function fixture() {
  // entry 0: a legacy competing arb via its own program (RISE program + pool passed as accounts), + CU price
  const arb = legacyTx(0xa1, [COMPETITOR, POOL_ADDRESS, reserveX, RISE_PROGRAM_ID, DLMM_PROGRAM_ID, OTHER_PROG, "ComputeBudget111111111111111111111111111111"], [
    { p: 6, a: [], d: [3, ...u64(123_456)] },
    { p: 6, a: [], d: [2, ...u32(300_000)] },
    { p: 5, a: [0, 1, 2, 3, 4], d: [1, 2, 3] },
  ]);
  // an unrelated legacy transfer
  const noise = legacyTx(0xb2, [Keypair.generate().publicKey, Keypair.generate().publicKey, "11111111111111111111111111111111"], [{ p: 2, a: [0, 1], d: [2, 0, 0, 0] }]);
  // entry 1: a v1 pool swap (top-level DLMM) with priority fee + CU limit in the v1 config
  const swap = v1Tx(0xc3, [COMPETITOR, POOL_ADDRESS, DLMM_PROGRAM_ID], [{ p: 2, a: [0, 1], d: [9, 9] }], { priorityFee: 77_000n, cuLimit: 200_000 });
  return entries([entry(1, 1, [arb, noise]), entry(12_500, 2, [swap]), entry(5, 3, [])]);
}

test("decodes a hand-built bincode Vec<Entry> with legacy + v1 txs (and zero padding)", () => {
  const buf = Buffer.concat([fixture(), Buffer.alloc(64)]);
  const es = decodeEntries(buf);
  assert.equal(es.length, 3);
  assert.equal(es[0].numHashes, 1n);
  assert.equal(es[1].numHashes, 12_500n);
  assert.equal(es[0].hash, bs58.encode(Buffer.alloc(32, 1)));
  assert.equal(es[0].transactions.length, 2);
  assert.equal(es[2].transactions.length, 0);
  const [arb, noise] = es[0].transactions;
  assert.equal(arb.version, "legacy");
  assert.equal(arb.signatures[0], bs58.encode(sig(0xa1)));
  assert.equal(arb.staticKeys[0], COMPETITOR.toBase58());
  assert.equal(arb.instructions.length, 3);
  assert.deepEqual([...arb.instructions[2].accounts], [0, 1, 2, 3, 4]);
  assert.equal(noise.staticKeys.length, 3);
  const v1 = es[1].transactions[0];
  assert.equal(v1.version, 1);
  assert.equal(v1.signatures[0], bs58.encode(sig(0xc3)));
  assert.deepEqual(v1.v1Config, { priorityFee: 77_000n, computeUnitLimit: 200_000 });
  assert.deepEqual([...v1.instructions[0].data], [9, 9]);
  assert.equal(v1.recentBlockhash, bs58.encode(Buffer.alloc(32, 7)));
});

test("rejects truncated / trailing garbage / implausible counts", () => {
  const f = fixture();
  assert.throws(() => decodeEntries(f.subarray(0, f.length - 1)), /unexpected end/);
  assert.throws(() => decodeEntries(Buffer.concat([f, Buffer.from([1])])), /trailing/);
  assert.throws(() => decodeEntries(u64(2n ** 63n)), /implausible/);
  assert.throws(() => decodeEntries(Buffer.alloc(0)), /unexpected end/);
});

test("legacy and v0 bytes produced by @solana/web3.js decode identically (cross-check)", () => {
  const payer = Keypair.generate();
  const ix = new TransactionInstruction({ programId: new PublicKey(DLMM_PROGRAM_ID), keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(POOL_ADDRESS), isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]) });
  const cu = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5555 });
  const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [new PublicKey(RISE_PROGRAM_ID), new PublicKey(reserveX)] } });
  const riseIx = new TransactionInstruction({ programId: new PublicKey(RISE_PROGRAM_ID), keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }], data: Buffer.from([4]) });
  const bh = bs58.encode(Buffer.alloc(32, 5));
  const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [cu, ix] }).compileToV0Message([alt]));
  v0.sign([payer]);
  // a tx whose reserve account comes only from the lookup table
  const viaAlt = new VersionedTransaction(MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [new TransactionInstruction({ programId: OTHER_PROG, keys: [{ pubkey: new PublicKey(reserveX), isSigner: false, isWritable: true }, { pubkey: new PublicKey(RISE_PROGRAM_ID), isSigner: false, isWritable: false }], data: Buffer.from([0]) })], addressLookupTableAccounts: [alt] }));
  viaAlt.sign([payer]);
  const legacy = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [riseIx] }).compileToLegacyMessage());
  legacy.sign([payer]);
  const buf = entries([entry(3, 4, [Buffer.from(v0.serialize()), Buffer.from(legacy.serialize()), Buffer.from(viaAlt.serialize())])]);
  const [e] = decodeEntries(buf);
  const [d0, dl, da] = e.transactions;
  assert.equal(d0.version, 0);
  assert.equal(dl.version, "legacy");
  assert.equal(d0.signatures[0], bs58.encode(v0.signatures[0]));
  assert.equal(dl.signatures[0], bs58.encode(legacy.signatures[0]));
  assert.deepEqual(d0.staticKeys, v0.message.staticAccountKeys.map((k) => k.toBase58()));
  assert.deepEqual(dl.staticKeys, legacy.message.staticAccountKeys.map((k) => k.toBase58()));
  assert.equal(da.lookups.length, 1);
  assert.equal(da.lookups[0].table, alt.key.toBase58());
  const w = defaultWatchSet();
  const h0 = classifyTx(d0, 50, w)!;
  assert.equal(h0.kind, "pool-swap");
  assert.equal(h0.cuPriceMicroLamports, 5555n);
  assert.equal(classifyTx(dl, 50, w)!.kind, "rise");
  // unresolved ALT: the hidden RISE program / reserve are not seen
  assert.equal(classifyTx(da, 50, w), null);
  // with the table resolved the same tx is a competing arb
  const resolver: LookupResolver = { get: (t) => (t === alt.key.toBase58() ? alt.state.addresses.map((a) => a.toBase58()) : undefined) };
  const ha = classifyTx(da, 50, w, resolver)!;
  assert.equal(ha.kind, "arb");
  assert.equal(ha.unresolvedLookups, 0);
});

test("filter: arb / pool-swap / rise / ignore; own wallet is never competing", () => {
  const [e0, e1] = decodeEntries(fixture());
  const w = defaultWatchSet();
  assert.deepEqual(w.reserves, [dlmmReserve(POOL_ADDRESS, RISE_MINT), dlmmReserve(POOL_ADDRESS, WSOL_MINT)]);
  const arb = classifyTx(e0.transactions[0], 10, w)!;
  assert.equal(arb.kind, "arb");
  assert.equal(arb.own, false);
  assert.equal(arb.feePayer, COMPETITOR.toBase58());
  assert.equal(arb.cuPriceMicroLamports, 123_456n);
  assert.equal(arb.cuLimit, 300_000);
  assert.deepEqual(arb.programs.sort(), [OTHER_PROG.toBase58(), "ComputeBudget111111111111111111111111111111"].sort());
  assert.equal(classifyTx(e0.transactions[1], 10, w), null);
  const swap = classifyTx(e1.transactions[0], 10, w)!;
  assert.equal(swap.kind, "pool-swap");
  assert.equal(swap.v1PriorityFee, 77_000n);
  assert.equal(swap.cuLimit, 200_000);
  assert.equal(classifyTx(e0.transactions[0], 10, defaultWatchSet([COMPETITOR.toBase58()]))!.own, true);
});

test("protobuf: Entry message decode, request encode, block markers", () => {
  const f = fixture();
  const m = decodeEntryMessage(pbEntry(468_123_456, f));
  assert.equal(m.slot, 468_123_456);
  assert.deepEqual(Buffer.from(m.entries), f);
  assert.equal(encodeSubscribeEntriesRequest().length, 0, "empty request = Jito-compatible");
  // transactions{"bot": {account_include: ["A"]}} + commitment = 0
  assert.deepEqual([...encodeSubscribeEntriesRequest({ accountInclude: ["A"], commitment: 0 })], [0x1a, 10, 0x0a, 3, 0x62, 0x6f, 0x74, 0x12, 3, 0x1a, 1, 0x41, 0x30, 0]);
  assert.equal(classifyPayload(f), "entries");
  assert.equal(classifyPayload(Buffer.alloc(16)), "empty");
  // Alpenglow marker: zero count, version u16 = 1, variant, u16 len, data
  assert.equal(classifyPayload(Buffer.concat([u64(0), u16(1), Buffer.from([0]), u16(2), Buffer.from([7, 7])])), "block-marker");
});

test("ShredFeed: logs hits, signals the engine, records pending activity; markers and bad payloads are skipped", () => {
  const signal = new ChangeSignal();
  let now = 1000;
  const pending = new PendingActivity(1500, () => now);
  const logs: string[] = [];
  const feed = new ShredFeed({ connect: async () => { throw new Error("unused"); }, watch: defaultWatchSet(), pending, signal, log: (m) => logs.push(m), now: () => now });
  const hits = feed.onMessage(pbEntry(200, fixture()));
  assert.deepEqual(hits.map((h) => h.kind), ["arb", "pool-swap"]);
  assert.equal(signal.notifies, 1);
  assert.equal(logs.filter((l) => l.includes("pending arb")).length, 1);
  assert.equal(feed.onMessage(pbEntry(201, Buffer.concat([u64(0), u16(1), Buffer.from([0]), u16(1), Buffer.from([1])]))).length, 0);
  assert.equal(feed.stats.markers, 1);
  feed.onMessage(pbEntry(202, Buffer.from([1, 2, 3])));
  assert.equal(feed.stats.decodeErrors, 1);
  // hold hint: a competing arb at slot 200 is "pending" for snapshots at slot <= 200 within the window
  assert.equal(pending.competingArb(200)!.slot, 200);
  assert.equal(pending.competingArb(201), null, "already reflected in a later snapshot");
  assert.deepEqual(pending.summary(199), { arb: 1, poolSwap: 1, rise: 0 });
  now += 2000;
  assert.equal(pending.competingArb(150), null, "expired");
});

test("ShredFeed reconnects with backoff after stream errors", async () => {
  const { EventEmitter } = await import("node:events");
  const streams: InstanceType<typeof EventEmitter>[] = [];
  const reqs: Buffer[] = [];
  const feed = new ShredFeed({
    connect: async (req) => { reqs.push(req); const s = Object.assign(new EventEmitter(), { cancel() {} }); streams.push(s); return s; },
    watch: defaultWatchSet(), reconnectMinMs: 5, reconnectMaxMs: 10, log: () => {},
  });
  feed.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(feed.status, "connected");
  streams[0].emit("error", new Error("UNAVAILABLE"));
  assert.equal(feed.status, "disconnected");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(streams.length, 2);
  assert.equal(feed.status, "connected");
  assert.equal(feed.stats.reconnects, 1);
  feed.close();
});
