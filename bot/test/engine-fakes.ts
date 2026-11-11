// Synthetic venues for engine tests (no I/O). Amounts are bigint base units.
import { Keypair, PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import type { DlmmVenue, RiseVenue } from "../src/types.js";

export const FAKE_RISE_PROG = new PublicKey("RiseP9yY3UnMxd1df7mgGJiR39frg9QGsr1ro3zxrDq");
export const FAKE_DLMM_PROG = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const BIN_ARRAY = Keypair.generate().publicKey;

function u64s(tag: number, ...xs: bigint[]): Buffer {
  const b = Buffer.alloc(1 + 8 * xs.length);
  b[0] = tag;
  xs.forEach((x, i) => b.writeBigUInt64LE(x, 1 + 8 * i));
  return b;
}
export function decodeFakeIx(ix: TransactionInstruction): { tag: number; args: bigint[] } {
  const args: bigint[] = [];
  for (let o = 1; o + 8 <= ix.data.length; o += 8) args.push(ix.data.readBigUInt64LE(o));
  return { tag: ix.data[0], args };
}

/** RISE native venue with a fixed price (lamports per 1e9 RISE units) and a fee in bps on each side. */
export class LinearRise implements RiseVenue {
  constructor(public priceE9: bigint, public feeBps: bigint) {}
  accounts() { return []; }
  update() {}
  quoteBuy(l: bigint) { return ((l * (10_000n - this.feeBps)) / 10_000n * 1_000_000_000n) / this.priceE9; }
  quoteSell(r: bigint) { return ((r * this.priceE9) / 1_000_000_000n * (10_000n - this.feeBps)) / 10_000n; }
  buyIx(user: PublicKey, l: bigint, min: bigint) { return new TransactionInstruction({ programId: FAKE_RISE_PROG, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: u64s(1, l, min) }); }
  sellIx(user: PublicKey, r: bigint, min: bigint) { return new TransactionInstruction({ programId: FAKE_RISE_PROG, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: u64s(2, r, min) }); }
}

abstract class FakeDlmmBase implements DlmmVenue {
  accounts() { return []; }
  update() {}
  abstract quoteExactIn(side: "sellRise" | "buyRise", amountIn: bigint): { out: bigint; binArrays: PublicKey[] } | null;
  abstract quoteExactOut(side: "sellRise" | "buyRise", amountOut: bigint): { inp: bigint; binArrays: PublicKey[] } | null;
  swapExactInIx(user: PublicKey, side: "sellRise" | "buyRise", amountIn: bigint, minOut: bigint, binArrays: PublicKey[]) {
    return new TransactionInstruction({ programId: FAKE_DLMM_PROG, keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))], data: u64s(side === "sellRise" ? 3 : 4, amountIn, minOut) });
  }
  swapExactOutIx(user: PublicKey, side: "sellRise" | "buyRise", amountOut: bigint, maxIn: bigint, binArrays: PublicKey[]) {
    return new TransactionInstruction({ programId: FAKE_DLMM_PROG, keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))], data: u64s(side === "sellRise" ? 5 : 6, amountOut, maxIn) });
  }
}

/** Constant-product pool: x = SOL reserve, y = RISE reserve, fee bps on input. */
export class CpDlmm extends FakeDlmmBase {
  constructor(public x: bigint, public y: bigint, public feeBps: bigint) { super(); }
  quoteExactIn(side: "sellRise" | "buyRise", a: bigint) {
    const net = (a * (10_000n - this.feeBps)) / 10_000n;
    const [ri, ro] = side === "sellRise" ? [this.y, this.x] : [this.x, this.y];
    const out = (ro * net) / (ri + net);
    return out > 0n ? { out, binArrays: [BIN_ARRAY] } : null;
  }
  quoteExactOut(side: "sellRise" | "buyRise", out: bigint) {
    const [ri, ro] = side === "sellRise" ? [this.y, this.x] : [this.x, this.y];
    if (out >= ro) return null;
    const net = (ri * out + (ro - out) - 1n) / (ro - out);
    const inp = (net * 10_000n + (10_000n - this.feeBps) - 1n) / (10_000n - this.feeBps);
    return { inp, binArrays: [BIN_ARRAY] };
  }
}

/**
 * Discrete bins: bin i has price p_i (lamports per 1e9 RISE) and finite liquidity.
 * Selling RISE walks bids downward; buying RISE walks asks upward. Each bin rounds
 * down independently and charges a fixed per-bin dust fee, so profit is a
 * non-smooth, non-unimodal-in-detail function of size.
 */
export class BinDlmm extends FakeDlmmBase {
  constructor(
    /** bids: [priceE9, lamports available], best first (descending price) */
    public bids: [bigint, bigint][],
    /** asks: [priceE9, RISE available], best first (ascending price) */
    public asks: [bigint, bigint][],
    public feeBps: bigint,
    public perBinFee = 0n,
  ) { super(); }
  quoteExactIn(side: "sellRise" | "buyRise", a: bigint) {
    let rem = (a * (10_000n - this.feeBps)) / 10_000n, out = 0n;
    if (side === "sellRise") {
      for (const [p, liq] of this.bids) {
        if (rem <= 0n) break;
        const maxRise = (liq * 1_000_000_000n) / p;
        const take = rem < maxRise ? rem : maxRise;
        const got = (take * p) / 1_000_000_000n;
        out += got > this.perBinFee ? got - this.perBinFee : 0n;
        rem -= take;
      }
    } else {
      for (const [p, liq] of this.asks) {
        if (rem <= 0n) break;
        const maxLam = (liq * p) / 1_000_000_000n;
        const take = rem < maxLam ? rem : maxLam;
        out += (take * 1_000_000_000n) / p;
        rem -= take;
      }
    }
    if (rem > 0n) return null;
    return { out, binArrays: [BIN_ARRAY] };
  }
  quoteExactOut(side: "sellRise" | "buyRise", want: bigint) {
    if (side !== "buyRise") throw new Error("not needed");
    let rem = want, inp = 0n;
    for (const [p, liq] of this.asks) {
      if (rem <= 0n) break;
      const take = rem < liq ? rem : liq;
      inp += (take * p + 999_999_999n) / 1_000_000_000n + this.perBinFee;
      rem -= take;
    }
    if (rem > 0n) return null;
    inp = (inp * 10_000n + (10_000n - this.feeBps) - 1n) / (10_000n - this.feeBps);
    return { inp, binArrays: [BIN_ARRAY] };
  }
}

/** SPL token account data with a given amount (only `amount` at offset 64 matters to the engine). */
export function tokenAccountData(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

export function tokenAccountInfo(amount: bigint, owner = PublicKey.default): AccountInfo<Buffer> {
  return { data: tokenAccountData(amount), executable: false, lamports: 2_039_280, owner, rentEpoch: 0 };
}
