// Raw Solana shred wire format (parser + Merkle helpers). No I/O.
//
// Verified against the Agave source of solana-ledger 4.4.1 (latest stable on crates.io,
// 2026-11): src/shred.rs, src/shred/{merkle.rs, merkle_tree.rs, wire.rs, common.rs,
// shred_data.rs, shred_code.rs, traits.rs, filter.rs}, src/shredder.rs. 4.4.1 no longer has
// src/shred/legacy.rs; the legacy and unchained-Merkle variants below were checked
// against solana-ledger 2.3.13 (the last line that still parses them).
//
// Common header (83 bytes, wincode = little-endian, fixed width):
//   [0..64)  signature (leader's ed25519 signature of the FEC set's Merkle root)
//   [64]     shred variant
//   [65..73) slot u64   [73..77) index u32   [77..79) version u16   [79..83) fec_set_index u32
// Data header (5 bytes, total 88):  [83..85) parent_offset u16  [85] flags u8  [86..88) size u16
//   size = headers + data length; data = payload[88..size).
// Coding header (6 bytes, total 89): [83..85) num_data_shreds  [85..87) num_coding_shreds  [87..89) position
// Variant byte (high nibble = kind, low nibble = Merkle proof_size = #proof entries):
//   0xa5 legacy data, 0x5a legacy code (obsolete, rejected by Agave 4.x)
//   0x4? Merkle code (unchained), 0x8? Merkle data (unchained) (obsolete, rejected by Agave 4.x)
//   0x6? Merkle code chained, 0x7? chained + resigned
//   0x9? Merkle data chained, 0xb? chained + resigned
// Merkle payload sizes: data 1203 (= 1228 - 89 + 64), code 1228 (= PACKET_DATA_SIZE 1232 - nonce 4).
// Merkle layout: headers | data buffer / erasure shard (capacity bytes)
//   | [chained Merkle root, 32, if chained] | proof (proof_size x 20) | [retransmitter signature, 64, if resigned]
//   capacity = PAYLOAD - (HEADERS + 32·chained + 20·proof_size + 64·resigned)
//   erasure shard: data payload[64 .. 88+capacity) (common/data headers minus the signature are
//                  erasure coded), code payload[89 .. 89+capacity) — both 1107 - 20p - 64r - 32c bytes.
//   Merkle leaf = sha256("\x00SOLANA_MERKLE_SHREDS_LEAF" || payload[64 .. proof_offset))
//   node        = sha256("\x01SOLANA_MERKLE_SHREDS_NODE" || left[0..20] || right[0..20])
//   leaf order = erasure shard index: data (index - fec_set_index), then code (num_data + position).
// Flags: low 6 bits = reference tick, 0x40 DATA_COMPLETE_SHRED, 0xc0 LAST_SHRED_IN_SLOT (implies 0x40).
//
// Sanity checks mirror Agave's ShredData/ShredCode::sanitize plus the ingest filter
// (shred/filter.rs, SIMD-0317 fixed 32:32 erasure sets) when strictFixedFec is on.
import { createHash } from "node:crypto";

export const SIZE_OF_SIGNATURE = 64;
export const SIZE_OF_COMMON_SHRED_HEADER = 83;
export const SIZE_OF_DATA_SHRED_HEADERS = 88;
export const SIZE_OF_CODING_SHRED_HEADERS = 89;
export const SIZE_OF_MERKLE_ROOT = 32;
export const SIZE_OF_MERKLE_PROOF_ENTRY = 20;
export const MERKLE_DATA_PAYLOAD = 1203;
export const MERKLE_CODE_PAYLOAD = 1228;
export const LEGACY_PAYLOAD = 1228;
export const DATA_SHREDS_PER_FEC_BLOCK = 32;
export const CODING_SHREDS_PER_FEC_BLOCK = 32;
/** solana-cost-model 4.4.1 shred_limit DEFAULT_MAX_{DATA,CODE}_SHREDS_PER_SLOT */
export const MAX_DATA_SHREDS_PER_SLOT = 32_768;
export const MAX_CODE_SHREDS_PER_SLOT = 32_768;
/** merkle_tree.rs PROOF_ENTRIES_FOR_32_32_BATCH */
export const PROOF_ENTRIES_FOR_32_32_BATCH = 6;
export const FLAG_TICK_MASK = 0x3f;
export const FLAG_DATA_COMPLETE = 0x40;
export const FLAG_LAST_IN_SLOT = 0xc0;
export const LEGACY_DATA_VARIANT = 0xa5;
export const LEGACY_CODE_VARIANT = 0x5a;

export const MERKLE_LEAF_PREFIX = Buffer.from("\x00SOLANA_MERKLE_SHREDS_LEAF", "latin1");
export const MERKLE_NODE_PREFIX = Buffer.from("\x01SOLANA_MERKLE_SHREDS_NODE", "latin1");

export type ShredType = "data" | "code";

export interface ShredVariant {
  type: ShredType;
  legacy: boolean;
  proofSize: number;
  chained: boolean;
  resigned: boolean;
}

/** Decode the variant byte (payload[64]); null if invalid. */
export function parseVariant(b: number): ShredVariant | null {
  if (b === LEGACY_DATA_VARIANT) return { type: "data", legacy: true, proofSize: 0, chained: false, resigned: false };
  if (b === LEGACY_CODE_VARIANT) return { type: "code", legacy: true, proofSize: 0, chained: false, resigned: false };
  const proofSize = b & 0x0f;
  switch (b & 0xf0) {
    case 0x40: return { type: "code", legacy: false, proofSize, chained: false, resigned: false };
    case 0x60: return { type: "code", legacy: false, proofSize, chained: true, resigned: false };
    case 0x70: return { type: "code", legacy: false, proofSize, chained: true, resigned: true };
    case 0x80: return { type: "data", legacy: false, proofSize, chained: false, resigned: false };
    case 0x90: return { type: "data", legacy: false, proofSize, chained: true, resigned: false };
    case 0xb0: return { type: "data", legacy: false, proofSize, chained: true, resigned: true };
    default: return null;
  }
}

export function variantByte(v: Omit<ShredVariant, "legacy">): number {
  if (v.resigned && !v.chained) throw new Error("resigned requires chained");
  const hi = v.type === "code" ? (v.chained ? (v.resigned ? 0x70 : 0x60) : 0x40) : (v.chained ? (v.resigned ? 0xb0 : 0x90) : 0x80);
  return hi | (v.proofSize & 0x0f);
}

export function payloadSize(t: ShredType): number { return t === "data" ? MERKLE_DATA_PAYLOAD : MERKLE_CODE_PAYLOAD; }
export function headersSize(t: ShredType): number { return t === "data" ? SIZE_OF_DATA_SHRED_HEADERS : SIZE_OF_CODING_SHRED_HEADERS; }

/** Merkle data buffer (data) / erasure shard (code) capacity; < 0 when the proof does not fit. */
export function merkleCapacity(t: ShredType, proofSize: number, chained: boolean, resigned: boolean): number {
  return payloadSize(t) - (headersSize(t) + (chained ? SIZE_OF_MERKLE_ROOT : 0) + proofSize * SIZE_OF_MERKLE_PROOF_ENTRY + (resigned ? SIZE_OF_SIGNATURE : 0));
}

export interface ParsedShred {
  type: ShredType;
  variant: number;
  proofSize: number;
  chained: boolean;
  resigned: boolean;
  /** The shred payload (packet truncated to the variant's payload size). */
  payload: Uint8Array;
  signature: Uint8Array;
  slot: number;
  index: number;
  version: number;
  fecSetIndex: number;
  capacity: number;
  /** Erasure-coded byte range within the payload. */
  shardStart: number;
  shardEnd: number;
  /** -1 when unchained. */
  chainedRootOffset: number;
  proofOffset: number;
  /** -1 when not resigned. */
  retransmitterSignatureOffset: number;
  /** Erasure shard index within the FEC set (Merkle leaf index). */
  erasureShardIndex: number;
  // data only
  parentOffset: number;
  flags: number;
  size: number;
  dataComplete: boolean;
  lastInSlot: boolean;
  referenceTick: number;
  /** data: payload[88..size) */
  data: Uint8Array;
  // code only
  numData: number;
  numCoding: number;
  position: number;
}

export type ShredError =
  | "short" | "variant" | "obsolete-legacy" | "obsolete-unchained" | "capacity" | "slot" | "index"
  | "flags" | "size" | "parent" | "erasure" | "fec-layout";

export type ParseResult = { ok: true; shred: ParsedShred } | { ok: false; error: ShredError; detail?: string };

export interface ParseOptions {
  /** Parse unchained Merkle variants (0x4?/0x8?) instead of rejecting them as obsolete. Default false (Agave 4.x rejects them). */
  allowUnchained?: boolean;
  /** Enforce the fixed 32:32 FEC layout of Agave's ingest filter (SIMD-0317). Default true. */
  strictFixedFec?: boolean;
}

const fail = (error: ShredError, detail?: string): ParseResult => ({ ok: false, error, detail });

/** Parse one packet. Never throws; malformed input yields { ok: false }. */
export function parseShred(packet: Uint8Array, o: ParseOptions = {}): ParseResult {
  if (packet.length <= SIZE_OF_SIGNATURE) return fail("short");
  const v = parseVariant(packet[SIZE_OF_SIGNATURE]);
  if (!v) return fail("variant", `0x${packet[SIZE_OF_SIGNATURE].toString(16)}`);
  if (v.legacy) return fail("obsolete-legacy");
  if (!v.chained && !o.allowUnchained) return fail("obsolete-unchained");
  const size = payloadSize(v.type);
  if (packet.length < size) return fail("short", `${packet.length} < ${size}`);
  const p = packet.subarray(0, size);
  const capacity = merkleCapacity(v.type, v.proofSize, v.chained, v.resigned);
  if (capacity <= 0) return fail("capacity");
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const slotBig = dv.getBigUint64(65, true);
  if (slotBig > BigInt(Number.MAX_SAFE_INTEGER)) return fail("slot");
  const slot = Number(slotBig);
  const index = dv.getUint32(73, true);
  const version = dv.getUint16(77, true);
  const fecSetIndex = dv.getUint32(79, true);
  const hs = headersSize(v.type);
  const chainedRootOffset = v.chained ? hs + capacity : -1;
  const proofOffset = hs + capacity + (v.chained ? SIZE_OF_MERKLE_ROOT : 0);
  const retransmitterSignatureOffset = v.resigned ? proofOffset + v.proofSize * SIZE_OF_MERKLE_PROOF_ENTRY : -1;
  const strict = o.strictFixedFec !== false;
  const base = {
    type: v.type, variant: p[SIZE_OF_SIGNATURE], proofSize: v.proofSize, chained: v.chained, resigned: v.resigned,
    payload: p, signature: p.subarray(0, SIZE_OF_SIGNATURE), slot, index, version, fecSetIndex, capacity,
    chainedRootOffset, proofOffset, retransmitterSignatureOffset,
  };
  if (strict) {
    // filter.rs check_fixed_fec_set
    if (fecSetIndex % DATA_SHREDS_PER_FEC_BLOCK !== 0 || index < fecSetIndex || index >= fecSetIndex + DATA_SHREDS_PER_FEC_BLOCK) return fail("fec-layout", `index ${index} fec ${fecSetIndex}`);
  }
  if (v.type === "data") {
    if (index >= MAX_DATA_SHREDS_PER_SLOT) return fail("index");
    const parentOffset = dv.getUint16(83, true);
    const flags = p[85];
    const dsize = dv.getUint16(86, true);
    // sanitize: LAST_SHRED_IN_SLOT implies DATA_COMPLETE_SHRED
    if ((flags & FLAG_LAST_IN_SLOT) !== 0 && (flags & FLAG_DATA_COMPLETE) === 0) return fail("flags", `0x${flags.toString(16)}`);
    // ShredData::get_data
    if (dsize < SIZE_OF_DATA_SHRED_HEADERS || dsize > SIZE_OF_DATA_SHRED_HEADERS + capacity) return fail("size", String(dsize));
    // traits::ShredData::parent
    if ((parentOffset === 0 && slot !== 0) || parentOffset > slot) return fail("parent", String(parentOffset));
    if (index < fecSetIndex) return fail("erasure");
    const dataComplete = (flags & FLAG_DATA_COMPLETE) !== 0;
    const lastInSlot = (flags & FLAG_LAST_IN_SLOT) === FLAG_LAST_IN_SLOT;
    if (strict) {
      if (dataComplete && index !== fecSetIndex + DATA_SHREDS_PER_FEC_BLOCK - 1) return fail("fec-layout", "DATA_COMPLETE not at the end of the FEC set");
      if (lastInSlot && (index + 1) % DATA_SHREDS_PER_FEC_BLOCK !== 0) return fail("fec-layout", "misaligned LAST_SHRED_IN_SLOT");
    }
    return {
      ok: true,
      shred: {
        ...base, shardStart: SIZE_OF_SIGNATURE, shardEnd: SIZE_OF_DATA_SHRED_HEADERS + capacity, erasureShardIndex: index - fecSetIndex,
        parentOffset, flags, size: dsize, dataComplete, lastInSlot, referenceTick: flags & FLAG_TICK_MASK,
        data: p.subarray(SIZE_OF_DATA_SHRED_HEADERS, dsize), numData: 0, numCoding: 0, position: 0,
      },
    };
  }
  if (index >= MAX_CODE_SHREDS_PER_SLOT) return fail("index");
  const numData = dv.getUint16(83, true);
  const numCoding = dv.getUint16(85, true);
  const position = dv.getUint16(87, true);
  // shred_code.rs sanitize + erasure_shard_index
  if (numCoding > 8 * DATA_SHREDS_PER_FEC_BLOCK || numData === 0 || numCoding === 0) return fail("erasure", `${numData}:${numCoding}`);
  if (fecSetIndex + numData - 1 >= MAX_DATA_SHREDS_PER_SLOT) return fail("erasure");
  const firstCoding = index - position;
  if (firstCoding < 0 || firstCoding + numCoding - 1 >= MAX_CODE_SHREDS_PER_SLOT) return fail("erasure");
  if (position >= numCoding) return fail("erasure", "position");
  if (numData + numCoding > 256) return fail("erasure", "too many shards");
  if (strict && (numData !== DATA_SHREDS_PER_FEC_BLOCK || numCoding !== CODING_SHREDS_PER_FEC_BLOCK)) return fail("fec-layout", `erasure config ${numData}:${numCoding}`);
  return {
    ok: true,
    shred: {
      ...base, shardStart: SIZE_OF_CODING_SHRED_HEADERS, shardEnd: SIZE_OF_CODING_SHRED_HEADERS + capacity, erasureShardIndex: numData + position,
      parentOffset: 0, flags: 0, size: 0, dataComplete: false, lastInSlot: false, referenceTick: 0, data: new Uint8Array(0),
      numData, numCoding, position,
    },
  };
}

// ============================ Merkle ============================

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** merkle.rs get_merkle_node: leaf over payload[64 .. proof_offset). */
export function merkleLeaf(payload: Uint8Array, proofOffset: number): Buffer {
  return sha256(MERKLE_LEAF_PREFIX, payload.subarray(SIZE_OF_SIGNATURE, proofOffset));
}

export function joinNodes(a: Uint8Array, b: Uint8Array): Buffer {
  return sha256(MERKLE_NODE_PREFIX, a.subarray(0, SIZE_OF_MERKLE_PROOF_ENTRY), b.subarray(0, SIZE_OF_MERKLE_PROOF_ENTRY));
}

/** merkle_tree.rs MerkleTree::try_new: all nodes, root last. */
export function merkleTree(leaves: Uint8Array[]): Uint8Array[] {
  if (!leaves.length) throw new Error("merkle: empty");
  const nodes = [...leaves];
  let size = leaves.length;
  while (size > 1) {
    const offset = nodes.length - size;
    for (let i = offset; i < offset + size; i += 2) nodes.push(joinNodes(nodes[i], nodes[Math.min(i + 1, offset + size - 1)]));
    size = (size + 1) >> 1;
  }
  return nodes;
}

/** merkle_tree.rs make_merkle_proof (20-byte entries). */
export function merkleProof(nodes: Uint8Array[], index: number, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (size > 1) {
    out.push(nodes[offset + Math.min(index ^ 1, size - 1)].subarray(0, SIZE_OF_MERKLE_PROOF_ENTRY));
    offset += size;
    size = (size + 1) >> 1;
    index >>= 1;
  }
  return out;
}

/** merkle_tree.rs get_proof_size */
export function proofSizeFor(numShreds: number): number {
  const bits = 32 - Math.clz32(numShreds);
  return (numShreds & (numShreds - 1)) === 0 ? Math.max(0, bits - 1) : bits;
}

/** Merkle root implied by a parsed shred's own proof (merkle_tree.rs get_merkle_root). */
export function merkleRootOf(s: ParsedShred): Buffer | null {
  let node = merkleLeaf(s.payload, s.proofOffset);
  let index = s.erasureShardIndex;
  for (let i = 0; i < s.proofSize; i++) {
    const at = s.proofOffset + i * SIZE_OF_MERKLE_PROOF_ENTRY;
    const other = s.payload.subarray(at, at + SIZE_OF_MERKLE_PROOF_ENTRY);
    node = index % 2 === 0 ? joinNodes(node, other) : joinNodes(other, node);
    index >>= 1;
  }
  return index === 0 ? node : null;
}
