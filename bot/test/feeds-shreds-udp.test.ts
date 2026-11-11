import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { parseShred, merkleRootOf, merkleCapacity, proofSizeFor, type ParsedShred } from "../src/feeds/shred-wire.js";
import { ReedSolomon, gfMul, mulSlice } from "../src/feeds/reed-solomon.js";
import { ShredsUdpFeed, replayCapture, type BatchEvent } from "../src/feeds/shreds-udp.js";
import { capture, encodeCaptureHeader, encodeCaptureRecord, readCapture } from "../src/feeds/shreds-udp-capture.js";
import { decodeEntries, defaultWatchSet, dlmmReserve, PendingActivity } from "../src/feeds/shreds.js";
import { ChangeSignal } from "../src/feeds/signal.js";
import { describeConfig, loadConfig } from "../src/config.js";
import { DLMM_PROGRAM_ID, POOL_ADDRESS, RISE_MINT, RISE_PROGRAM_ID } from "../src/types.js";

// =====================================================================================
// In-test shredder, written from the Agave 4.4.1 spec (shred/merkle.rs make_shreds_from_data,
// finish_erasure_batch; merkle_tree.rs) with raw offsets, independent of src/feeds/shred-wire.ts.
// Signatures are real ed25519 signatures of the Merkle root by a random key (we never verify them).
// =====================================================================================

const PROOF = 6;
const LEAF = Buffer.from("\x00SOLANA_MERKLE_SHREDS_LEAF", "latin1");
const NODE = Buffer.from("\x01SOLANA_MERKLE_SHREDS_NODE", "latin1");
const sha = (...p: Uint8Array[]) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const capData = (resigned: boolean) => 1203 - 88 - 32 - 20 * PROOF - (resigned ? 64 : 0);
const capCode = (resigned: boolean) => 1228 - 89 - 32 - 20 * PROOF - (resigned ? 64 : 0);
const leader = generateKeyPairSync("ed25519");

function tree(leaves: Buffer[]): Buffer[] {
  const nodes = [...leaves];
  let size = leaves.length;
  while (size > 1) {
    const off = nodes.length - size;
    for (let i = off; i < off + size; i += 2) nodes.push(sha(NODE, nodes[i].subarray(0, 20), nodes[Math.min(i + 1, off + size - 1)].subarray(0, 20)));
    size = (size + 1) >> 1;
  }
  return nodes;
}
function proof(nodes: Buffer[], index: number, size: number): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (size > 1) { out.push(nodes[off + Math.min(index ^ 1, size - 1)].subarray(0, 20)); off += size; size = (size + 1) >> 1; index >>= 1; }
  return out;
}

interface FecOut { fec: number; data: Buffer[]; code: Buffer[]; root: Buffer; resigned: boolean }

function buildFecSet(o: { slot: number; parentOffset: number; version: number; fec: number; chainedRoot: Buffer; resigned: boolean; chunks: Buffer[]; lastFlag: number; refTick: number }): FecOut {
  const cd = capData(o.resigned), cc = capCode(o.resigned);
  assert.equal(cd + 24, cc, "erasure shard sizes match");
  const data: Buffer[] = [], code: Buffer[] = [];
  for (let i = 0; i < 32; i++) {
    const chunk = o.chunks[i] ?? Buffer.alloc(0);
    assert.ok(chunk.length <= cd);
    const p = Buffer.alloc(1203);
    p[64] = (o.resigned ? 0xb0 : 0x90) | PROOF;
    p.writeBigUInt64LE(BigInt(o.slot), 65);
    p.writeUInt32LE(o.fec + i, 73);
    p.writeUInt16LE(o.version, 77);
    p.writeUInt32LE(o.fec, 79);
    p.writeUInt16LE(o.parentOffset, 83);
    p[85] = Math.min(o.refTick, 0x3f) | (i === 31 ? o.lastFlag : 0);
    p.writeUInt16LE(88 + chunk.length, 86);
    chunk.copy(p, 88);
    data.push(p);
  }
  for (let j = 0; j < 32; j++) {
    const p = Buffer.alloc(1228);
    p[64] = (o.resigned ? 0x70 : 0x60) | PROOF;
    p.writeBigUInt64LE(BigInt(o.slot), 65);
    p.writeUInt32LE(o.fec + j, 73);
    p.writeUInt16LE(o.version, 77);
    p.writeUInt32LE(o.fec, 79);
    p.writeUInt16LE(32, 83);
    p.writeUInt16LE(32, 85);
    p.writeUInt16LE(j, 87);
    code.push(p);
  }
  // erasure code: data payload[64 .. 88+cap), code payload[89 .. 89+cap)
  const shards = [...data.map((p) => p.subarray(64, 88 + cd)), ...code.map((p) => p.subarray(89, 89 + cc))];
  new ReedSolomon(32, 32).encode(shards);
  const all = [...data, ...code];
  const proofOff = (p: Buffer) => (p.length === 1203 ? 88 + cd : 89 + cc) + 32;
  for (const p of all) o.chainedRoot.copy(p, proofOff(p) - 32);
  const nodes = tree(all.map((p) => sha(LEAF, p.subarray(64, proofOff(p)))));
  const root = nodes[nodes.length - 1];
  const sig = edSign(null, root, leader.privateKey);
  all.forEach((p, k) => {
    proof(nodes, k, 64).forEach((e, n) => e.copy(p, proofOff(p) + 20 * n));
    sig.copy(p, 0);
    if (o.resigned) randomBytes(64).copy(p, p.length - 64); // retransmitter signature
  });
  return { fec: o.fec, data, code, root, resigned: o.resigned };
}

/** make_shreds_from_data: full FEC sets, then a final padded one; the batch's last data shred gets the flag. */
function shredBatch(bytes: Buffer, o: { slot: number; startIndex: number; last: boolean; chainedRoot?: Buffer; parentOffset?: number; version?: number }): { sets: FecOut[]; nextIndex: number; root: Buffer } {
  const capU = capData(false), capS = capData(true);
  const lastBuf = o.last ? capS : capU, lastTotal = 32 * lastBuf;
  let rest = bytes, idx = o.startIndex, root = o.chainedRoot ?? Buffer.alloc(32, 0x42);
  const sets: FecOut[] = [];
  const mk = (chunk: Buffer, buf: number, resigned: boolean, final: boolean) => {
    const chunks: Buffer[] = [];
    for (let k = 0; k < chunk.length; k += buf) chunks.push(chunk.subarray(k, k + buf));
    const set = buildFecSet({ slot: o.slot, parentOffset: o.parentOffset ?? 1, version: o.version ?? 50093, fec: idx, chainedRoot: root, resigned, chunks, lastFlag: final ? (o.last ? 0xc0 : 0x40) : 0, refTick: 7 });
    sets.push(set);
    root = set.root;
    idx += 32;
  };
  while (rest.length > lastTotal) {
    const full = rest.length > 32 * capU;
    const total = full ? 32 * capU : 32 * capS;
    mk(rest.subarray(0, total), full ? capU : capS, !full, false);
    rest = rest.subarray(total);
  }
  mk(rest, lastBuf, o.last, true);
  return { sets, nextIndex: idx, root };
}
const packetsOf = (sets: FecOut[], withCode = true) => sets.flatMap((s) => [...s.data, ...(withCode ? s.code : [])]);

// ---------- entries (bincode Vec<Entry>, legacy txs) ----------
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const shortVec = (n: number) => { const out: number[] = []; let v = n; for (;;) { const b = v & 0x7f; v >>= 7; if (v) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); };
const key = (k: string | PublicKey) => (typeof k === "string" ? new PublicKey(k) : k).toBuffer();
function legacyTx(sigFill: number, keys: (string | PublicKey)[], ixData: number[]) {
  return Buffer.concat([shortVec(1), Buffer.alloc(64, sigFill), Buffer.from([1, 0, 1]), shortVec(keys.length), ...keys.map(key), Buffer.alloc(32, 9),
    shortVec(1), Buffer.from([keys.length - 1]), shortVec(2), Buffer.from([0, 1]), shortVec(ixData.length), Buffer.from(ixData)]);
}
const entry = (n: number, txs: Buffer[]) => Buffer.concat([u64(n), Buffer.alloc(32, 3), u64(txs.length), ...txs]);
const entries = (es: Buffer[]) => Buffer.concat([u64(es.length), ...es]);
const COMPETITOR = Keypair.generate().publicKey;
const ARB_SIG = 0xa1;
const arbTx = () => legacyTx(ARB_SIG, [COMPETITOR, POOL_ADDRESS, dlmmReserve(POOL_ADDRESS, RISE_MINT), RISE_PROGRAM_ID, DLMM_PROGRAM_ID, Keypair.generate().publicKey], [1, 2, 3]);
const noiseTx = (i: number, size = 200) => legacyTx(1 + (i % 200), [Keypair.generate().publicKey, Keypair.generate().publicKey, "11111111111111111111111111111111"], [...Buffer.alloc(size, i & 0xff)]);
/** ~`n` noise entries + one arb tx (at the end). */
function batchBytes(n: number, withArb = true) {
  const es: Buffer[] = [];
  for (let i = 0; i < n; i++) es.push(entry(1, [noiseTx(i)]));
  if (withArb) es.push(entry(2, [arbTx()]));
  return entries(es);
}

// ---------- feed helper ----------
function feedFor(opts: Partial<ConstructorParameters<typeof ShredsUdpFeed>[0]> = {}) {
  const batches: BatchEvent[] = [];
  const logs: string[] = [];
  const signal = new ChangeSignal();
  let now = 0;
  const pending = new PendingActivity(1e12, () => now);
  const feed = new ShredsUdpFeed({ watch: defaultWatchSet(), signal, pending, log: (m) => logs.push(m), onBatch: (b) => batches.push(b), now: () => now, summaryMs: 0, ...opts });
  return { feed, batches, logs, signal, pending, setNow: (t: number) => { now = t; } };
}
const SRC = "10.0.0.1";
function shuffle<T>(xs: T[], seed = 1): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// =====================================================================================

test("reed-solomon matches reed-solomon-erasure 6.0.0 vectors and recovers any 32 of 64", () => {
  assert.equal(gfMul(3, 4), 12);
  assert.equal(gfMul(7, 7), 21);
  assert.equal(gfMul(23, 45), 41);
  const input = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 10, 50, 100, 150, 174, 201, 255, 99, 32, 67, 85, 200, 199, 198, 197, 196, 195, 194, 193, 192, 191, 190, 189, 188, 187, 186, 185]);
  const out = new Uint8Array(input.length);
  mulSlice(25, input, out);
  assert.equal(Buffer.from(out).toString("hex"), "0019322b647d56fab86dc785c31f220725feda5d446f7639200b121108233a756c47");
  // core.rs test_reconstruct: RS(2,2) of [0,1,2],[3,4,5] -> parity [6,11,12],[5,14,11]
  const s = [Uint8Array.from([0, 1, 2]), Uint8Array.from([3, 4, 5]), new Uint8Array(3), new Uint8Array(3)];
  new ReedSolomon(2, 2).encode(s);
  assert.deepEqual(s.map((x) => [...x]), [[0, 1, 2], [3, 4, 5], [6, 11, 12], [5, 14, 11]]);
  const rs = new ReedSolomon(32, 32);
  const shards = Array.from({ length: 64 }, (_, i) => (i < 32 ? Uint8Array.from(randomBytes(100)) : new Uint8Array(100)));
  rs.encode(shards);
  for (let trial = 0; trial < 20; trial++) {
    const drop = new Set(shuffle([...Array(64).keys()], trial + 7).slice(0, 32));
    const got = shards.map((x, i) => (drop.has(i) ? null : x));
    rs.reconstruct(got);
    got.forEach((x, i) => assert.deepEqual(x, shards[i], `shard ${i}`));
  }
  assert.throws(() => rs.reconstruct(shards.map((x, i) => (i < 33 ? null : x))), /too few/);
});

test("parser: Merkle data/code headers, payload bounds, proofs (chained and resigned)", () => {
  for (const resigned of [false, true]) {
    const set = buildFecSet({ slot: 468_000_123, parentOffset: 2, version: 50093, fec: 64, chainedRoot: Buffer.alloc(32, 0x11), resigned, chunks: [Buffer.from("hello"), Buffer.alloc(capData(resigned), 7)], lastFlag: 0x40, refTick: 9 });
    const d0 = parseShred(set.data[0]);
    assert.ok(d0.ok);
    const d = (d0 as { shred: ParsedShred }).shred;
    assert.equal(d.type, "data");
    assert.equal(d.variant, (resigned ? 0xb0 : 0x90) | 6);
    assert.equal(d.proofSize, 6);
    assert.equal(d.chained, true);
    assert.equal(d.resigned, resigned);
    assert.equal(d.slot, 468_000_123);
    assert.equal(d.index, 64);
    assert.equal(d.fecSetIndex, 64);
    assert.equal(d.version, 50093);
    assert.equal(d.parentOffset, 2);
    assert.equal(d.referenceTick, 9);
    assert.equal(d.dataComplete, false);
    assert.equal(Buffer.from(d.data).toString(), "hello");
    assert.equal(d.capacity, resigned ? 899 : 963);
    assert.equal(d.chainedRootOffset, 88 + d.capacity);
    assert.equal(d.proofOffset, 88 + d.capacity + 32);
    assert.equal(d.retransmitterSignatureOffset, resigned ? 1203 - 64 : -1);
    const full = (parseShred(set.data[1]) as { shred: ParsedShred }).shred;
    assert.equal(full.data.length, capData(resigned));
    const last = (parseShred(set.data[31]) as { shred: ParsedShred }).shred;
    assert.equal(last.dataComplete, true);
    assert.equal(last.lastInSlot, false);
    assert.equal(last.data.length, 0);
    const c = (parseShred(set.code[5]) as { shred: ParsedShred }).shred;
    assert.equal(c.type, "code");
    assert.equal(c.variant, (resigned ? 0x70 : 0x60) | 6);
    assert.deepEqual([c.numData, c.numCoding, c.position, c.index], [32, 32, 5, 69]);
    assert.equal(c.erasureShardIndex, 37);
    assert.equal(c.capacity, resigned ? 923 : 987);
    assert.equal(c.retransmitterSignatureOffset, resigned ? 1228 - 64 : -1);
    // every shred's own proof leads to the FEC set's root
    for (const p of [...set.data, ...set.code]) assert.deepEqual(merkleRootOf((parseShred(p) as { shred: ParsedShred }).shred), set.root);
    // a turbine/repair packet may be longer (repair nonce): truncated to the payload size
    const long = parseShred(Buffer.concat([set.data[0], Buffer.from([1, 2, 3, 4])]));
    assert.ok(long.ok && long.shred.payload.length === 1203);
  }
  assert.equal(proofSizeFor(64), 6);
  assert.equal(merkleCapacity("data", 6, true, false), 963);
});

test("parser: obsolete, invalid and inconsistent shreds are rejected with a reason", () => {
  const set = buildFecSet({ slot: 1000, parentOffset: 1, version: 1, fec: 0, chainedRoot: Buffer.alloc(32), resigned: false, chunks: [Buffer.from("x")], lastFlag: 0x40, refTick: 0 });
  const mut = (p: Buffer, f: (b: Buffer) => void) => { const b = Buffer.from(p); f(b); return parseShred(b); };
  const err = (r: ReturnType<typeof parseShred>) => (r.ok ? "ok" : r.error);
  assert.equal(err(mut(set.data[0], (b) => { b[64] = 0xa5; })), "obsolete-legacy");
  assert.equal(err(mut(set.code[0], (b) => { b[64] = 0x5a; })), "obsolete-legacy");
  assert.equal(err(mut(set.data[0], (b) => { b[64] = 0x86; })), "obsolete-unchained");
  // unchained Merkle data (0x8?) parses when allowed: no chained root, capacity 995
  const u = mut(set.data[0], (b) => { b[64] = 0x86; });
  assert.equal(u.ok, false);
  const ua = parseShred(Buffer.from(set.data[0]).fill(0x86, 64, 65), { allowUnchained: true });
  assert.ok(ua.ok && ua.shred.capacity === 995 && ua.shred.chainedRootOffset === -1 && ua.shred.proofOffset === 88 + 995);
  for (const v of [0x00, 0x20, 0xc6, 0xf6, 0x56]) assert.equal(err(mut(set.data[0], (b) => { b[64] = v; })), "variant");
  assert.equal(err(parseShred(set.data[0].subarray(0, 1202))), "short");
  assert.equal(err(parseShred(set.code[0].subarray(0, 1227))), "short");
  assert.equal(err(parseShred(Buffer.alloc(10))), "short");
  // any proof size 0..15 fits in the payload; a non-32:32 proof size parses (Agave's filter only counts it until SIMD-0317 enforcement)
  assert.equal(err(mut(set.data[0], (b) => { b[64] = 0x9f; })), "ok");
  assert.equal(err(mut(set.data[0], (b) => { b[85] = 0x80; })), "flags"); // LAST_IN_SLOT bit without DATA_COMPLETE
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt16LE(87, 86); })), "size");
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt16LE(88 + 964, 86); })), "size");
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt16LE(0, 83); })), "parent");
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt16LE(1001, 83); })), "parent");
  assert.equal(err(mut(set.data[0], (b) => { b[85] = 0x40; })), "fec-layout"); // DATA_COMPLETE not at fec+31
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt32LE(33, 73); })), "fec-layout");
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt32LE(5, 79); b.writeUInt32LE(5, 73); })), "fec-layout");
  assert.equal(err(mut(set.code[0], (b) => { b.writeUInt16LE(31, 83); })), "fec-layout");
  assert.equal(err(mut(set.code[0], (b) => { b.writeUInt16LE(40, 87); })), "erasure");
  assert.equal(err(mut(set.code[0], (b) => { b.writeUInt16LE(0, 85); })), "erasure");
  assert.equal(err(mut(set.data[0], (b) => { b.writeUInt32LE(40_000, 73); b.writeUInt32LE(40_000 - (40_000 % 32), 79); })), "index");
  assert.equal(err(mut(set.data[0], (b) => { b.writeBigUInt64LE(2n ** 63n, 65); })), "slot");
});

test("parser fuzz: random and mutated buffers never throw", () => {
  const set = buildFecSet({ slot: 77, parentOffset: 1, version: 1, fec: 0, chainedRoot: Buffer.alloc(32), resigned: true, chunks: [Buffer.alloc(500, 1)], lastFlag: 0xc0, refTick: 0 });
  let ok = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 20_000; i++) {
    let b: Buffer;
    if (i % 2) b = randomBytes(rnd() % 1400);
    else {
      b = Buffer.from([...set.data, ...set.code][rnd() % 64]);
      for (let k = 0; k < 1 + (rnd() % 8); k++) b[rnd() % b.length] = rnd() & 0xff;
      if (rnd() % 4 === 0) b = b.subarray(0, rnd() % b.length);
    }
    const r = parseShred(b, { allowUnchained: !!(i & 4), strictFixedFec: !(i & 8) });
    if (r.ok) { ok++; merkleRootOf(r.shred); }
  }
  assert.ok(ok > 0, "some mutated shreds still parse");
});

test("UDP deshred: one batch in order -> entries decoded, arb matched, engine woken, pending recorded, latency from first shred", () => {
  const { feed, batches, logs, signal, pending, setNow } = feedFor();
  const bytes = batchBytes(3);
  const { sets } = shredBatch(bytes, { slot: 5000, startIndex: 0, last: false });
  assert.equal(sets.length, 1);
  let t = 100;
  for (const p of packetsOf(sets)) { setNow(t); feed.ingest(p, SRC, t); t += 0.5; }
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.deepEqual([b.slot, b.start, b.end, b.kind, b.recovered], [5000, 0, 31, "entries", false]);
  assert.equal(b.bytes, bytes.length);
  assert.equal(b.entries, 4);
  assert.equal(b.txs, 4);
  assert.equal(b.hits.length, 1);
  assert.equal(b.hits[0].kind, "arb");
  assert.equal(b.hits[0].signature, bs58.encode(Buffer.alloc(64, ARB_SIG)));
  assert.equal(b.latencyMs, 31 * 0.5, "first data shred -> last data shred (DATA_COMPLETE) arrival");
  assert.equal(signal.notifies, 1);
  assert.equal(pending.competingArb(5000)!.feePayer, COMPETITOR.toBase58());
  assert.ok(logs.some((l) => l.startsWith("[shred-udp 5000] pending arb") && l.includes("ms from first shred")));
  assert.equal(feed.stats.dataShreds, 32);
  assert.equal(feed.stats.codeShreds, 32);
  assert.equal(feed.stats.matches, 1);
  assert.equal(feed.stats.decodeErrors, 0);
  const s = feed.summary();
  assert.equal(s.matches, 1);
  assert.equal(s.matchLatencyP50Ms, 15.5);
  assert.equal(s.completedBatches, 1);
});

test("UDP deshred: out-of-order and duplicate arrival emit exactly one batch", () => {
  const { feed, batches } = feedFor();
  const bytes = batchBytes(150); // > 1 FEC set
  const { sets } = shredBatch(bytes, { slot: 6000, startIndex: 0, last: false });
  assert.ok(sets.length >= 2);
  const pk = packetsOf(sets);
  for (const p of shuffle([...pk, ...pk.slice(0, 40), ...pk.slice(10, 20)], 3)) feed.ingest(p, SRC, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].bytes, bytes.length);
  assert.equal(batches[0].hits.length, 1);
  // Recovery runs as soon as any 32 shards of a FEC set are in (coding shreds may come first);
  // data shreds that arrive after being recovered count as duplicates.
  assert.equal(feed.stats.duplicates, 50 + feed.stats.recoveredShreds);
  assert.equal(feed.stats.recoveryFailures, 0);
});

test("UDP deshred: a missing data shred without recovery -> incomplete batch, counted at eviction", () => {
  const { feed, batches } = feedFor({ recovery: false });
  const { sets } = shredBatch(batchBytes(3), { slot: 7000, startIndex: 0, last: false });
  for (const p of packetsOf(sets)) if (p !== sets[0].data[4]) feed.ingest(p, SRC, 1);
  assert.equal(batches.length, 0);
  feed.drain();
  assert.equal(feed.stats.incompleteBatches, 1);
  assert.equal(feed.stats.incompleteFecSets, 1);
  assert.equal(feed.stats.orphanDataShreds, 31);
});

test("UDP erasure recovery: missing data shreds are rebuilt from coding shreds and Merkle-verified", () => {
  for (const missing of [1, 10, 32]) {
    const { feed, batches } = feedFor();
    const bytes = batchBytes(3);
    const { sets } = shredBatch(bytes, { slot: 8000, startIndex: 0, last: false });
    const drop = new Set(shuffle(sets[0].data, missing).slice(0, missing));
    // data first, then coding shreds (turbine order): recovery fires on the first coding shred that makes 32
    for (const p of packetsOf(sets)) if (!drop.has(p)) feed.ingest(p, SRC, 1);
    assert.equal(batches.length, 1, `missing ${missing}`);
    assert.equal(batches[0].recovered, true);
    assert.equal(batches[0].bytes, bytes.length);
    assert.equal(batches[0].hits.length, 1);
    assert.equal(feed.stats.recoveredShreds, missing);
    assert.equal(feed.stats.recoveredFecSets, 1);
    assert.equal(feed.stats.recoveryFailures, 0);
    assert.equal(feed.stats.recoveredBatches, 1);
  }
  // shuffled arrival: recovered as early as possible, the batch is still exact
  {
    const { feed, batches } = feedFor();
    const bytes = batchBytes(3);
    const { sets } = shredBatch(bytes, { slot: 8050, startIndex: 0, last: false });
    const drop = new Set(sets[0].data.slice(0, 5));
    for (const p of shuffle(packetsOf(sets), 5)) if (!drop.has(p)) feed.ingest(p, SRC, 1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].bytes, bytes.length);
    assert.ok(feed.stats.recoveredShreds >= 5);
    assert.equal(feed.stats.duplicates, feed.stats.recoveredShreds - 5);
  }
  // too few shards: 20 data + 13 code missing leaves 31 < 32
  const { feed, batches } = feedFor();
  const { sets } = shredBatch(batchBytes(3), { slot: 8100, startIndex: 0, last: false });
  const keep = [...sets[0].data.slice(20), ...sets[0].code.slice(13)];
  for (const p of keep) feed.ingest(p, SRC, 1);
  assert.equal(batches.length, 0);
  feed.drain();
  assert.equal(feed.stats.unrecoverableFecSets, 1);
});

test("UDP erasure recovery: a corrupted coding shred fails the Merkle check and is not emitted", () => {
  const { feed, batches } = feedFor();
  const bytes = batchBytes(3);
  const { sets } = shredBatch(bytes, { slot: 8200, startIndex: 0, last: false });
  const bad = Buffer.from(sets[0].code[0]);
  bad[200] ^= 0xff; // inside the erasure shard; signature and proof untouched
  const data = sets[0].data;
  for (const p of data.slice(1)) feed.ingest(p, SRC, 1);
  feed.ingest(bad, SRC, 1);
  assert.equal(batches.length, 0);
  assert.equal(feed.stats.recoveryFailures, 1);
  // the real data shred arrives later: batch is correct
  feed.ingest(data[0], SRC, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].bytes, bytes.length);
  assert.equal(batches[0].recovered, false);
});

test("UDP deshred: multiple batches and FEC sets per slot, slot boundary with LAST_IN_SLOT (resigned), mid-slot join", () => {
  const { feed, batches } = feedFor();
  const a = batchBytes(1);
  const b = batchBytes(160); // 2+ FEC sets
  const c = batchBytes(2);
  const s1a = shredBatch(a, { slot: 9000, startIndex: 0, last: false });
  const s1b = shredBatch(b, { slot: 9000, startIndex: s1a.nextIndex, last: true, chainedRoot: s1a.root });
  const s2 = shredBatch(c, { slot: 9001, startIndex: 0, last: false, chainedRoot: s1b.root });
  assert.equal(s1b.sets.at(-1)!.resigned, true, "last FEC set of the slot is resigned");
  // drop some data in the resigned set too: recovered with the resigned layout
  const lastSet = s1b.sets.at(-1)!;
  const drop = new Set(lastSet.data.slice(3, 9));
  const all = [...packetsOf(s1a.sets), ...packetsOf(s1b.sets), ...packetsOf(s2.sets)].filter((p) => !drop.has(p));
  for (const p of shuffle(all, 9)) feed.ingest(p, SRC, 1);
  const got = batches.map((x) => `${x.slot}:${x.start}-${x.end}:${x.bytes}`).sort();
  assert.deepEqual(got, [`9000:0-31:${a.length}`, `9000:32-${s1b.nextIndex - 1}:${b.length}`, `9001:0-31:${c.length}`].sort());
  assert.ok(batches.every((x) => x.hits.length === 1 && x.kind === "entries"));
  assert.ok(feed.stats.recoveredShreds >= 6);
  assert.equal(feed.stats.recoveryFailures, 0);
  const lastInSlot = parseShred(lastSet.data[31]);
  assert.ok(lastInSlot.ok && lastInSlot.shred.lastInSlot && lastInSlot.shred.resigned);

  // mid-slot join: batch 2 of a slot is not decodable until the previous DATA_COMPLETE shred is seen
  const j = feedFor({ recovery: false });
  const ja = shredBatch(batchBytes(1), { slot: 9100, startIndex: 0, last: false });
  const jb = shredBatch(batchBytes(1), { slot: 9100, startIndex: 32, last: false, chainedRoot: ja.root });
  for (const p of packetsOf(jb.sets)) j.feed.ingest(p, SRC, 1);
  assert.equal(j.batches.length, 0, "start unknown");
  j.feed.ingest(ja.sets[0].data[31], SRC, 2);
  assert.deepEqual(j.batches.map((x) => x.start), [32]);
});

test("UDP: slot eviction, stale/future slots, version filter, conflicting FEC signatures, memory cap", () => {
  const { feed } = feedFor({ maxSlotLag: 4, shredVersion: 50093 });
  const s = (slot: number, version = 50093) => shredBatch(batchBytes(1), { slot, startIndex: 0, last: false, version }).sets;
  for (const p of packetsOf(s(100))) feed.ingest(p, SRC, 1);
  for (const p of packetsOf(s(110)).slice(0, 2)) feed.ingest(p, SRC, 1);
  assert.equal(feed.stats.slotsEvicted, 1);
  feed.ingest(packetsOf(s(101))[0], SRC, 1);
  assert.equal(feed.stats.staleSlot, 1);
  feed.ingest(packetsOf(s(999_999))[0], SRC, 1);
  assert.equal(feed.stats.futureSlot, 1);
  feed.ingest(packetsOf(s(111, 7))[0], SRC, 1);
  assert.equal(feed.stats.versionMismatch, 1);
  // same (slot, fec) but a different leader signature: conflict, first one kept
  const x = s(112), y = s(112);
  feed.ingest(x[0].data[0], SRC, 1);
  feed.ingest(y[0].data[1], SRC, 1);
  assert.equal(feed.stats.conflicts, 1);

  const m = feedFor({ maxBufferedBytes: 200_000 });
  // 20 coding shreds per FEC set: not enough to recover, so shards stay buffered
  for (let slot = 1; slot <= 12; slot++) for (const p of s(slot)[0].code.slice(0, 20)) m.feed.ingest(p, SRC, 1);
  assert.ok(m.feed.stats.memoryEvictions > 0);
  assert.ok(m.feed.bufferedBytes <= 200_000);
});

test("UDP: garbage and mutated packets never throw out of ingest", () => {
  const { feed } = feedFor({ maxSlotLag: 1000 });
  const sets = shredBatch(batchBytes(40), { slot: 3000, startIndex: 0, last: true }).sets;
  const pk = packetsOf(sets);
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 6000; i++) {
    let b: Buffer;
    const r = i % 3;
    if (r === 0) b = randomBytes(rnd() % 1300);
    else {
      b = Buffer.from(pk[rnd() % pk.length]);
      for (let k = 0; k < 1 + (rnd() % 4); k++) b[64 + (rnd() % (b.length - 64))] = rnd() & 0xff;
    }
    feed.ingest(b, SRC, i);
  }
  for (const p of pk) feed.ingest(p, SRC, 7000);
  feed.drain();
  assert.equal(feed.stats.handlerErrors, 0);
  assert.ok(feed.stats.invalid > 1000);
  assert.ok(feed.summary().packets as number > 6000);
});

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
}

test("UDP socket: real loopback dgram, foreign sources dropped, effective rcvbuf logged", async () => {
  const { feed, batches, logs } = feedFor({ port: 0, bind: "127.0.0.1", allowedSources: ["127.0.0.1"], rcvbuf: 1 << 20, now: () => performance.now() });
  feed.start();
  await until(() => feed.status === "listening");
  const port = feed.address()!.port;
  assert.ok(logs.some((l) => l.includes("SO_RCVBUF effective")));
  assert.ok(feed.rcvbuf > 0);
  const { sets } = shredBatch(batchBytes(2), { slot: 4000, startIndex: 0, last: false });
  const send = async (from: string, pkts: Buffer[]) => {
    const c = createSocket("udp4");
    await new Promise<void>((r) => c.bind(0, from, () => r()));
    for (const p of pkts) await new Promise<void>((r, j) => c.send(p, port, "127.0.0.1", (e) => (e ? j(e) : r())));
    c.close();
  };
  await send("127.0.0.2", sets[0].data.slice(0, 5));
  await until(() => feed.stats.foreign === 5);
  assert.equal(feed.stats.dataShreds, 0);
  await send("127.0.0.1", sets[0].data);
  await until(() => batches.length === 1);
  assert.equal(batches[0].hits.length, 1);
  feed.close();

  const warn = feedFor({ port: 0, bind: "127.0.0.1" });
  warn.feed.start();
  assert.ok(warn.logs.some((l) => l.includes("SHREDS_UDP_ALLOWED_SOURCES is unset")));
  warn.feed.close();
});

test("capture file round trip + replay into the ingestor; capture tool records from a real socket", async () => {
  const { sets } = shredBatch(batchBytes(2), { slot: 4100, startIndex: 0, last: false });
  const t0 = 1_760_000_000_000_000_000n;
  const recs = [...sets[0].data].map((p, i) => encodeCaptureRecord({ tNs: t0 + BigInt(i) * 250_000n, address: i === 3 ? "10.9.9.9" : SRC, port: 8001, payload: p }));
  const file = Buffer.concat([encodeCaptureHeader(t0), ...recs]);
  const parsed = [...readCapture(file)];
  assert.equal(parsed.length, 32);
  assert.equal(parsed[3].address, "10.9.9.9");
  assert.deepEqual(Buffer.from(parsed[5].payload), sets[0].data[5]);
  assert.equal([...readCapture(file.subarray(0, file.length - 10))].length, 31, "truncated tail ignored");
  assert.throws(() => [...readCapture(Buffer.from("nope"))], /magic/);

  const { feed, batches } = feedFor({ allowedSources: [SRC, "10.9.9.9"] });
  assert.equal(replayCapture(file, feed), 32);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].latencyMs, 31 * 0.25, "latency from recorded arrival times");

  const dir = mkdtempSync(join(tmpdir(), "shredcap-"));
  try {
    const out = join(dir, "t.shredcap");
    const port = 40000 + Math.floor(Math.random() * 20000);
    const done = capture({ port, seconds: 0.6, out, bind: "127.0.0.1", log: () => {} });
    await new Promise((r) => setTimeout(r, 150));
    const c = createSocket("udp4");
    for (const p of sets[0].data) await new Promise<void>((r) => c.send(p, port, "127.0.0.1", () => r()));
    c.close();
    const res = await done;
    assert.equal(res.packets, 32);
    const r2 = feedFor();
    replayCapture(readFileSync(out), r2.feed);
    assert.equal(r2.batches.length, 1);
    await assert.rejects(capture({ port, seconds: 0.1, out, log: () => {} }), /exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: SHREDS_UDP_PORT enables UDP shreds and wins over SHREDSTREAM_ENDPOINT; IPs validated, not logged", () => {
  const base = { MODE: "simulate" } as NodeJS.ProcessEnv;
  const off = loadConfig(base);
  assert.equal(off.shredsUdp, null);
  const on = loadConfig({ ...base, SHREDS_UDP_PORT: "20000", SHREDS_UDP_ALLOWED_SOURCES: "192.0.2.10, 198.51.100.7", SHREDSTREAM_ENDPOINT: "http://x.invalid:1", SHREDS_UDP_RCVBUF: "134217728" });
  assert.equal(on.shreds, null);
  assert.equal(on.shredsUdp!.port, 20000);
  assert.equal(on.shredsUdp!.bind, "0.0.0.0");
  assert.equal(on.shredsUdp!.rcvbuf, 134217728);
  assert.deepEqual(on.shredsUdp!.allowedSources, ["192.0.2.10", "198.51.100.7"]);
  assert.equal(on.shredsUdp!.overridesShredstream, true);
  assert.equal(on.shredsUdp!.recovery, true);
  const d = describeConfig(on);
  assert.equal(d["shredsUdp.allowedSources"], "2 address(es)");
  assert.ok(!Object.values(d).some((v) => v.includes("192.0.2.10")));
  assert.throws(() => loadConfig({ ...base, SHREDS_UDP_PORT: "20000", SHREDS_UDP_ALLOWED_SOURCES: "erpc.example.com" }), /IP addresses/);
  assert.throws(() => loadConfig({ ...base, SHREDS_UDP_PORT: "70000" }), /SHREDS_UDP_PORT/);
  const grpcOnly = loadConfig({ ...base, SHREDSTREAM_ENDPOINT: "http://x.invalid:1" });
  assert.ok(grpcOnly.shreds && !grpcOnly.shredsUdp);
});

test("deshredded bytes decode with the shared Vec<Entry> decoder (round trip of the builder)", () => {
  const bytes = batchBytes(5);
  assert.equal(decodeEntries(bytes).length, 6);
});

test("infra: SHREDS_UDP_PORT wires the UDP feed (event-driven, summary hook), not the gRPC ShredStream", async () => {
  const { setupInfra } = await import("../src/feeds/index.js");
  const { Connection } = await import("@solana/web3.js");
  const port = 40000 + Math.floor(Math.random() * 20000);
  const cfg = loadConfig({ MODE: "simulate", SHREDS_UDP_PORT: String(port), SHREDS_UDP_BIND: "127.0.0.1", SHREDSTREAM_ENDPOINT: "http://x.invalid:1", SHREDS_UDP_ALLOWED_SOURCES: "127.0.0.1" } as NodeJS.ProcessEnv);
  const logs: string[] = [];
  const summaries: Record<string, unknown>[] = [];
  const infra = setupInfra(cfg, new Connection("http://127.0.0.1:1"), (m) => logs.push(m), { onShredsUdpSummary: (s) => summaries.push(s) });
  assert.ok(infra.shredsUdp);
  assert.equal(infra.shreds, undefined);
  assert.ok(infra.pending);
  assert.equal(infra.eventDriven, true);
  assert.match(infra.describe().shreds, /^udp 127\.0\.0\.1:\d+ \(1 allowed sources/);
  assert.ok(logs.some((l) => l.includes("ignoring SHREDSTREAM_ENDPOINT")));
  infra.start();
  await until(() => infra.shredsUdp!.status === "listening");
  const { sets } = shredBatch(batchBytes(1), { slot: 4200, startIndex: 0, last: false });
  const c = createSocket("udp4");
  for (const p of sets[0].data) await new Promise<void>((r) => c.send(p, port, "127.0.0.1", () => r()));
  c.close();
  assert.equal(await infra.wait(3000), "shred:arb");
  infra.shredsUdp!.flushSummary();
  assert.equal(summaries[0].kind, "shreds-udp");
  assert.equal(summaries[0].matches, 1);
  infra.close();
});
