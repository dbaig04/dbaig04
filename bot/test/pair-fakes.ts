// Synthetic SwapVenues for the pair engine tests (no I/O).
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
import type { SwapQuote, SwapSide, SwapVenue } from "../src/types.js";
import { tokenAccountInfo } from "./engine-fakes.js";

function ixData(tag: number, a: bigint, b: bigint): Buffer {
  const d = Buffer.alloc(17);
  d[0] = tag;
  d.writeBigUInt64LE(a, 1);
  d.writeBigUInt64LE(b, 9);
  return d;
}

abstract class FakeVenue implements SwapVenue {
  readonly programId = Keypair.generate().publicKey;
  /** Extra accounts to inflate tx size (tests of the lookup-table path). */
  extraAccounts: PublicKey[] = [];
  version = 0;
  constructor(readonly name: string, readonly tokenMint = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump") {}
  accounts(): PublicKey[] { return []; }
  update(_slot: number, _infos: Map<string, AccountInfo<Buffer> | null>): void {}
  abstract quoteKey(): string;
  abstract quoteExactIn(side: SwapSide, amountIn: bigint): SwapQuote | null;
  /** Apply a swap to the venue state (fake chain execution / competitor perturbation). */
  abstract apply(side: SwapSide, amountIn: bigint): SwapQuote | null;
  swapExactInIxs(user: PublicKey, side: SwapSide, amountIn: bigint, minOut: bigint): TransactionInstruction[] {
    return [new TransactionInstruction({
      programId: this.programId,
      keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...this.extraAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))],
      data: ixData(side === "buy" ? 1 : 2, amountIn, minOut),
    })];
  }
  programIds(): PublicKey[] { return [this.programId]; }
}

/** Constant product x·y, fee in bps taken from the input (PumpSwap-like). x = SOL reserve, y = token reserve. */
export class CpVenue extends FakeVenue {
  constructor(name: string, public x: bigint, public y: bigint, public feeBps: bigint) { super(name); }
  quoteKey() { return `${this.x}:${this.y}:${this.feeBps}`; }
  quoteExactIn(side: SwapSide, a: bigint): SwapQuote | null {
    if (a <= 0n) return null;
    const net = (a * (10_000n - this.feeBps)) / 10_000n;
    const [ri, ro] = side === "buy" ? [this.x, this.y] : [this.y, this.x];
    const out = (ro * net) / (ri + net);
    return out > 0n ? { out, netIn: a } : null;
  }
  apply(side: SwapSide, a: bigint) {
    const q = this.quoteExactIn(side, a);
    if (!q) return null;
    if (side === "buy") { this.x += a; this.y -= q.out; } else { this.y += a; this.x -= q.out; }
    return q;
  }
}

/**
 * Discrete bins (DLMM-like). price[i] = lamports per 1e6 token units. Each bin holds
 * `liq` lamports worth of depth on each side; per-bin rounding down; fee bps on input,
 * of which rebateBps of the input is paid back to the user (netIn < amountIn, host-fee-like).
 */
export class BinVenue extends FakeVenue {
  /** bins: [priceE6 (lamports per 1e6 token), lamports depth, token depth] ascending by price; active = index of first ask. */
  constructor(name: string, public bins: { p: bigint; sol: bigint; tok: bigint }[], public active: number, public feeBps: bigint, public rebateBps = 0n) { super(name); }
  quoteKey() { return `${this.active}:${this.bins.map((b) => `${b.sol}/${b.tok}`).join(",")}`; }
  private walk(side: SwapSide, a: bigint, mutate: boolean): SwapQuote | null {
    if (a <= 0n) return null;
    const fee = (a * this.feeBps + 9_999n) / 10_000n;
    const rebate = (a * this.rebateBps) / 10_000n;
    let rem = a - fee, out = 0n;
    const bins = mutate ? this.bins : this.bins.map((b) => ({ ...b }));
    if (side === "buy") {
      // buy token from asks (bins >= active, ascending price)
      for (let i = this.active; i < bins.length && rem > 0n; i++) {
        const b = bins[i];
        const maxIn = (b.tok * b.p) / 1_000_000n;
        const use = rem < maxIn ? rem : maxIn;
        const got = (use * 1_000_000n) / b.p;
        b.tok -= got; b.sol += use; out += got; rem -= use;
      }
    } else {
      for (let i = this.active - 1; i >= 0 && rem > 0n; i--) {
        const b = bins[i];
        const maxIn = (b.sol * 1_000_000n) / b.p;
        const use = rem < maxIn ? rem : maxIn;
        const got = (use * b.p) / 1_000_000n;
        b.sol -= got; b.tok += use; out += got; rem -= use;
      }
    }
    if (rem > 0n || out <= 0n) return null;
    return { out, netIn: a - rebate, ctx: { bins: 1 } };
  }
  quoteExactIn(side: SwapSide, a: bigint) { return this.walk(side, a, false); }
  apply(side: SwapSide, a: bigint) { return this.walk(side, a, true); }
}

/** Geometric ladder of bins around `mid` (lamports per 1e6 tokens), stepBps apart. */
export function ladder(mid: bigint, n: number, stepBps: bigint, solDepth: bigint): { p: bigint; sol: bigint; tok: bigint }[] {
  const out: { p: bigint; sol: bigint; tok: bigint }[] = [];
  for (let i = -n; i < n; i++) {
    let p = mid;
    if (i >= 0) for (let k = 0; k < i + 1; k++) p = (p * (10_000n + stepBps)) / 10_000n;
    else for (let k = 0; k < -i; k++) p = (p * 10_000n) / (10_000n + stepBps);
    // asks (i >= 0) hold tokens, bids hold SOL
    out.push(i >= 0 ? { p, sol: 0n, tok: (solDepth * 1_000_000n) / p } : { p, sol: solDepth, tok: 0n });
  }
  return out;
}

/** Fake RPC that executes the fake venues' ixs on a balance sheet (for engine pipeline tests). */
export function pairChain(venues: FakeVenue[], wsolAta: PublicKey, tokenAta: PublicKey, bal: { wsol: bigint; tok: bigint }) {
  let slot = 500;
  const sims: VersionedTransaction[] = [];
  const exec = (tx: VersionedTransaction) => {
    const m = tx.message;
    const keys = m.staticAccountKeys;
    const nb = { ...bal };
    // execute on copies of venue state: quotes only (state is not mutated by a simulation)
    for (const [i, ix] of m.compiledInstructions.entries()) {
      const pid = keys[ix.programIdIndex];
      if (pid.equals(ComputeBudgetProgram.programId)) continue;
      if (pid.equals(new PublicKey("11111111111111111111111111111111"))) continue; // tip transfer (native SOL)
      const v = venues.find((x) => x.programId.equals(pid));
      if (!v) throw new Error(`unknown program ${pid.toBase58()}`);
      const d = Buffer.from(ix.data);
      const a = d.readBigUInt64LE(1), min = d.readBigUInt64LE(9);
      const side: SwapSide = d[0] === 1 ? "buy" : "sell";
      const q = v.quoteExactIn(side, a);
      const fail = { err: { InstructionError: [i, { Custom: 6001 }] }, b: bal };
      if (!q || q.out < min) return fail;
      if (side === "buy") { if (nb.wsol < a) return fail; nb.wsol -= q.netIn; nb.tok += q.out; }
      else { if (nb.tok < a) return fail; nb.tok -= q.netIn; nb.wsol += q.out; }
    }
    return { err: null, b: nb };
  };
  const conn = {
    async getSlot() { return slot; },
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      return { context: { slot }, value: ks.map((k) => (k.equals(wsolAta) ? tokenAccountInfo(bal.wsol) : k.equals(tokenAta) ? tokenAccountInfo(bal.tok) : null)) };
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }; },
    async simulateTransaction(tx: VersionedTransaction, cfg: { accounts: { addresses: string[] } }) {
      if (cfg.accounts.addresses[0] !== wsolAta.toBase58() || cfg.accounts.addresses[1] !== tokenAta.toBase58()) throw new Error("unexpected sim accounts");
      sims.push(tx);
      const r = exec(tx);
      const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
      return { context: { slot }, value: { err: r.err, logs: [], unitsConsumed: 150_000, accounts: r.err ? null : [acc(r.b.wsol), acc(r.b.tok)] } };
    },
  };
  return { conn, sims, exec, bump: () => { slot++; } };
}
