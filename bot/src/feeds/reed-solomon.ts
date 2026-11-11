// Reed-Solomon erasure code over GF(2^8), bit-compatible with the Rust crate
// reed-solomon-erasure 6.0.0 (galois_8), which Agave's shredder uses (solana-ledger
// 4.4.1 depends on reed-solomon-erasure = "6.0.0"). Verified against its source:
//   * field: generating polynomial 29 (x^8 + x^4 + x^3 + x^2 + 1 = 0x11d), log/exp tables
//     built as in build.rs (gen_log_table / gen_exp_table), exp(a, n) = EXP[(LOG[a]*n) mod 255]
//     with exp(_, 0) = 1 and exp(0, n>0) = 0 (galois_8.rs `exp`).
//   * encoding matrix: build_matrix(d, total) = V · inv(V[0..d]) where V is the
//     total×d Vandermonde matrix V[r][c] = exp(r, c) (matrix.rs `vandermonde`, nth(r) = r).
//     The top d rows are the identity (systematic code), rows d.. produce parity.
//   * reconstruct: take the first d present shards in index order, invert the matching
//     rows of the encoding matrix, multiply (core.rs reconstruct_internal). The inverse
//     is unique, so the elimination order does not matter for the result.
// Cross-checked in tests against the crate's own vectors (galois_8 test_galois, core
// test_reconstruct).

const FIELD = 256;
const POLY = 29;

export const GF_LOG = new Uint8Array(FIELD);
export const GF_EXP = new Uint8Array(FIELD * 2 - 2);
{
  let b = 1;
  for (let log = 0; log < FIELD - 1; log++) {
    GF_LOG[b] = log;
    b <<= 1;
    if (b >= FIELD) b = (b - FIELD) ^ POLY;
  }
  for (let i = 1; i < FIELD; i++) {
    const l = GF_LOG[i];
    GF_EXP[l] = i;
    GF_EXP[l + FIELD - 1] = i;
  }
}
/** MUL[a * 256 + b] = a·b */
const MUL = new Uint8Array(FIELD * FIELD);
for (let a = 1; a < FIELD; a++) for (let b = 1; b < FIELD; b++) MUL[a * FIELD + b] = GF_EXP[GF_LOG[a] + GF_LOG[b]];

export function gfMul(a: number, b: number): number { return MUL[(a << 8) | b]; }
export function gfDiv(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new Error("gf: divide by zero");
  let l = GF_LOG[a] - GF_LOG[b];
  if (l < 0) l += 255;
  return GF_EXP[l];
}
export function gfExp(a: number, n: number): number {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] * n) % 255];
}
/** out[i] ^= c·input[i] */
export function mulSliceXor(c: number, input: Uint8Array, out: Uint8Array): void {
  if (c === 0) return;
  const row = c << 8;
  const n = Math.min(input.length, out.length);
  for (let i = 0; i < n; i++) out[i] ^= MUL[row | input[i]];
}
/** out[i] = c·input[i] */
export function mulSlice(c: number, input: Uint8Array, out: Uint8Array): void {
  const row = c << 8;
  const n = Math.min(input.length, out.length);
  for (let i = 0; i < n; i++) out[i] = MUL[row | input[i]];
}

type Matrix = Uint8Array[];

function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) => { const r = new Uint8Array(n); r[i] = 1; return r; });
}
function multiply(a: Matrix, b: Matrix): Matrix {
  const rows = a.length, inner = b.length, cols = b[0].length;
  const out: Matrix = Array.from({ length: rows }, () => new Uint8Array(cols));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let v = 0;
    for (let k = 0; k < inner; k++) v ^= gfMul(a[r][k], b[k][c]);
    out[r][c] = v;
  }
  return out;
}
/** Gauss-Jordan inverse over GF(2^8); throws on a singular matrix. */
export function invert(m: Matrix): Matrix {
  const n = m.length;
  const w = m.map((row, i) => { const r = new Uint8Array(2 * n); r.set(row); r[n + i] = 1; return r; });
  for (let r = 0; r < n; r++) {
    if (w[r][r] === 0) {
      for (let below = r + 1; below < n; below++) if (w[below][r] !== 0) { const t = w[r]; w[r] = w[below]; w[below] = t; break; }
    }
    if (w[r][r] === 0) throw new Error("rs: singular matrix");
    if (w[r][r] !== 1) { const s = gfDiv(1, w[r][r]); for (let c = 0; c < 2 * n; c++) w[r][c] = gfMul(s, w[r][c]); }
    for (let o = 0; o < n; o++) {
      if (o === r || w[o][r] === 0) continue;
      const s = w[o][r];
      for (let c = 0; c < 2 * n; c++) w[o][c] ^= gfMul(s, w[r][c]);
    }
  }
  return w.map((row) => row.slice(n));
}

export class ReedSolomon {
  readonly total: number;
  /** total × data encoding matrix (top data rows = identity). */
  readonly matrix: Matrix;
  constructor(readonly dataShards: number, readonly parityShards: number) {
    if (dataShards <= 0) throw new Error("rs: too few data shards");
    if (parityShards <= 0) throw new Error("rs: too few parity shards");
    if (dataShards + parityShards > FIELD) throw new Error("rs: too many shards");
    this.total = dataShards + parityShards;
    const v: Matrix = Array.from({ length: this.total }, (_, r) => {
      const row = new Uint8Array(dataShards);
      for (let c = 0; c < dataShards; c++) row[c] = gfExp(r, c);
      return row;
    });
    this.matrix = multiply(v, invert(v.slice(0, dataShards)));
  }

  /** Writes parity into shards[data..total] from shards[0..data]. All shards must have equal length. */
  encode(shards: Uint8Array[]): void {
    if (shards.length !== this.total) throw new Error("rs: wrong shard count");
    const len = shards[0].length;
    if (shards.some((s) => s.length !== len)) throw new Error("rs: shard size mismatch");
    for (let p = 0; p < this.parityShards; p++) {
      const out = shards[this.dataShards + p];
      out.fill(0);
      const row = this.matrix[this.dataShards + p];
      for (let d = 0; d < this.dataShards; d++) mulSliceXor(row[d], shards[d], out);
    }
  }

  /**
   * Fills the null entries of `shards` (length total) in place. Needs >= dataShards present
   * shards of equal length. With dataOnly, missing parity shards stay null.
   * Returns the indices that were reconstructed.
   */
  reconstruct(shards: (Uint8Array | null)[], dataOnly = false): number[] {
    if (shards.length !== this.total) throw new Error("rs: wrong shard count");
    let len = -1, present = 0;
    for (const s of shards) {
      if (!s) continue;
      if (s.length === 0) throw new Error("rs: empty shard");
      if (len >= 0 && s.length !== len) throw new Error("rs: shard size mismatch");
      len = s.length;
      present++;
    }
    if (present === this.total) return [];
    if (present < this.dataShards) throw new Error("rs: too few shards present");
    const valid: number[] = [];
    for (let i = 0; i < this.total && valid.length < this.dataShards; i++) if (shards[i]) valid.push(i);
    const decode = invert(valid.map((i) => this.matrix[i]));
    const sub = valid.map((i) => shards[i]!);
    const done: number[] = [];
    for (let d = 0; d < this.dataShards; d++) {
      if (shards[d]) continue;
      const out = new Uint8Array(len);
      for (let j = 0; j < this.dataShards; j++) mulSliceXor(decode[d][j], sub[j], out);
      shards[d] = out;
      done.push(d);
    }
    if (!dataOnly) {
      for (let p = this.dataShards; p < this.total; p++) {
        if (shards[p]) continue;
        const out = new Uint8Array(len);
        const row = this.matrix[p];
        for (let d = 0; d < this.dataShards; d++) mulSliceXor(row[d], shards[d]!, out);
        shards[p] = out;
        done.push(p);
      }
    }
    return done;
  }
}

const cache = new Map<string, ReedSolomon>();
/** Cached encoder/decoder per (data, parity), like Agave's ReedSolomonCache. */
export function reedSolomon(data: number, parity: number): ReedSolomon {
  const k = `${data}:${parity}`;
  let r = cache.get(k);
  if (!r) {
    r = new ReedSolomon(data, parity);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    cache.set(k, r);
  }
  return r;
}
