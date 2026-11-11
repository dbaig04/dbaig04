// RISE native mint/redeem venue. Quotes are exact because they are produced by
// executing the real on-chain program (fetched from its programdata account)
// against the latest account snapshot in LiteSVM, in a child process
// (see oracle.ts / svm-worker.mjs and NOTES.md).
import { PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { RiseVenue } from "../types.js";
import {
  MINT,
  RENT_SYSVAR,
  WSOL,
  buildBuyIx,
  buildSellIx,
  deriveAccounts,
  type RiseAccounts,
} from "./accounts.js";
import { decodeMarket, type MarketView } from "./market.js";
import { SvmOracle, type SnapshotAccount } from "./oracle.js";

export * from "./accounts.js";
export { decodeMarket, feeSplit, type MarketView } from "./market.js";
export { SvmOracle } from "./oracle.js";

export interface RiseNativeConfig {
  /** Used only to (re)fetch the program binary when the engine supplies a sliced programdata account. */
  connection?: Connection;
  /** Grid for the approximate *Fast quotes (lamports for buys). */
  fastBuyGrid?: bigint[];
  /** Grid for the approximate *Fast quotes (RISE base units for sells). */
  fastSellGrid?: bigint[];
}

const geo = (lo: number, hi: number, n: number) =>
  Array.from({ length: n }, (_, i) => BigInt(Math.round(lo * Math.pow(hi / lo, i / (n - 1)))));

const PROGRAM_CHECK_MS = 30_000;
const PROGRAMDATA_HEADER = 45; // u32 tag(3) | u64 deploy slot | Option<Pubkey> authority

export class RiseNative implements RiseVenue {
  readonly acc: RiseAccounts;
  readonly oracle = new SvmOracle();
  market: MarketView | null = null;
  slot = 0;
  /** Slot at which the currently loaded program binary was deployed. */
  programDeploySlot: bigint | null = null;
  private fetching = false;
  private lastProgramCheck = 0;
  /** True from detecting a program upgrade until the new binary is loaded: no quotes. */
  programStale = false;
  private cache = new Map<string, bigint | null>();
  private fastBuy: [bigint, bigint][] | null = null;
  private fastSell: [bigint, bigint][] | null = null;
  private readonly buyGrid: bigint[];
  private readonly sellGrid: bigint[];

  constructor(private readonly cfg: RiseNativeConfig = {}) {
    this.acc = deriveAccounts(MINT);
    this.buyGrid = cfg.fastBuyGrid ?? geo(1e6, 1e13, 22);
    this.sellGrid = cfg.fastSellGrid ?? geo(1e9, 1e16, 22);
  }

  /** Optional eager setup: fetch the program binary and an initial snapshot. */
  async init(conn: Connection | undefined = this.cfg.connection): Promise<void> {
    if (!conn) throw new Error("RiseNative.init needs a Connection");
    const pd = await conn.getAccountInfo(this.acc.programData, "confirmed");
    if (!pd || pd.data.length <= PROGRAMDATA_HEADER) throw new Error("RISE programdata not found");
    this.oracle.setProgram(Buffer.from(pd.data.subarray(PROGRAMDATA_HEADER)));
    this.programDeploySlot = pd.data.readBigUInt64LE(4);
    this.lastProgramCheck = Date.now();
    const keys = this.accounts();
    const r = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
    const m = new Map<string, AccountInfo<Buffer> | null>();
    keys.forEach((k, i) => m.set(k.toBase58(), r.value[i]));
    this.update(r.context.slot, m);
  }

  accounts(): PublicKey[] {
    return [
      this.acc.market,
      this.acc.vault,
      this.acc.creatorClaim,
      this.acc.teamVault,
      this.acc.reflectionVault,
      MINT,
      WSOL,
      RENT_SYSVAR,
    ];
  }

  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    this.slot = slot;
    this.cache.clear();
    this.fastBuy = this.fastSell = null;

    // The ~1.15 MB programdata account is NOT part of accounts() (it would be
    // re-downloaded every tick). Instead check its 45-byte header periodically and
    // refuse to quote (programStale) from the moment an upgrade is seen until the
    // new binary is loaded.
    // Callers (tests, validate.ts) may still pass a full programdata account explicitly.
    const pd = infos.get(this.acc.programData.toBase58());
    if (pd && pd.data.length > PROGRAMDATA_HEADER) {
      const deploy = pd.data.readBigUInt64LE(4);
      if (deploy !== this.programDeploySlot) {
        this.oracle.setProgram(Buffer.from(pd.data.subarray(PROGRAMDATA_HEADER)));
        this.programDeploySlot = deploy;
        this.programStale = false;
      }
    }
    if (Date.now() - this.lastProgramCheck > PROGRAM_CHECK_MS) this.checkProgram();

    const m = infos.get(this.acc.market.toBase58());
    this.market = m ? decodeMarket(Buffer.from(m.data)) : null;

    let rent: { lpby: string; thr: number; burn: number } | null = null;
    const r = infos.get(RENT_SYSVAR.toBase58());
    if (r && r.data.length >= 17) rent = { lpby: r.data.readBigUInt64LE(0).toString(), thr: r.data.readDoubleLE(8), burn: r.data[16] };

    const accounts: Record<string, SnapshotAccount | null> = {};
    for (const k of [this.acc.market, this.acc.vault, this.acc.creatorClaim, this.acc.teamVault, this.acc.reflectionVault, MINT, WSOL]) {
      const a = infos.get(k.toBase58());
      accounts[k.toBase58()] = a ? { lamports: a.lamports, owner: a.owner.toBase58(), data: Buffer.from(a.data).toString("base64"), executable: a.executable } : null;
    }
    this.oracle.setState({ slot, rent, accounts });
    this.oracle.warm();
  }

  private checkProgram(): void {
    const conn = this.cfg.connection;
    if (!conn || this.fetching) return;
    this.fetching = true;
    this.lastProgramCheck = Date.now();
    (async () => {
      const head = await conn.getAccountInfo(this.acc.programData, { commitment: "confirmed", dataSlice: { offset: 0, length: PROGRAMDATA_HEADER } });
      if (!head || head.data.length < 12) return;
      const deploy = head.data.readBigUInt64LE(4);
      if (deploy === this.programDeploySlot) return;
      this.programStale = true;
      this.cache.clear();
      const a = await conn.getAccountInfo(this.acc.programData, "confirmed");
      if (a && a.data.length > PROGRAMDATA_HEADER) {
        this.oracle.setProgram(Buffer.from(a.data.subarray(PROGRAMDATA_HEADER)));
        this.programDeploySlot = a.data.readBigUInt64LE(4);
        this.programStale = false;
        this.cache.clear();
        this.fastBuy = this.fastSell = null;
      }
    })().catch(() => { /* retried on next check */ }).finally(() => { this.fetching = false; });
  }

  private exact(kind: "buy" | "sell", amount: bigint): bigint | null {
    if (amount <= 0n || amount >= 1n << 64n) return null;
    if (!this.market || this.programStale || this.programDeploySlot === null) return null;
    // Avoid program-error paths we can predict (they are also where litesvm may abort).
    if (kind === "sell" && amount > this.market.supply) return null;
    if (kind === "buy" && amount < this.market.minTradeLamports) return null;
    const key = kind + amount.toString();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const r = this.oracle.quote(kind, amount);
    const out = r.out !== null && r.out > 0n ? r.out : null;
    this.cache.set(key, out);
    return out;
  }

  quoteBuy(lamportsIn: bigint): bigint | null {
    return this.exact("buy", lamportsIn);
  }

  quoteSell(riseIn: bigint): bigint | null {
    return this.exact("sell", riseIn);
  }

  /**
   * Approximate quotes for coarse searches: log-linear interpolation of the
   * average execution price between exact grid points (computed lazily once per
   * update). Never use the result as a min-out; always re-quote the final size exactly.
   * Outside the grid it falls back to the exact quote.
   */
  quoteBuyFast(lamportsIn: bigint): bigint | null {
    if (!this.fastBuy) this.fastBuy = this.buildGrid("buy", this.buyGrid);
    return this.interp(this.fastBuy, lamportsIn) ?? this.quoteBuy(lamportsIn);
  }

  quoteSellFast(riseIn: bigint): bigint | null {
    if (!this.fastSell) this.fastSell = this.buildGrid("sell", this.sellGrid);
    return this.interp(this.fastSell, riseIn) ?? this.quoteSell(riseIn);
  }

  private buildGrid(kind: "buy" | "sell", grid: bigint[]): [bigint, bigint][] {
    const pts: [bigint, bigint][] = [];
    for (const x of grid) {
      const y = this.exact(kind, x);
      if (y !== null) pts.push([x, y]);
    }
    return pts;
  }

  private interp(pts: [bigint, bigint][], x: bigint): bigint | null {
    if (pts.length < 2 || x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    let i = 1;
    while (pts[i][0] < x) i++;
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x === x1) return y1;
    const p0 = Number(y0) / Number(x0), p1 = Number(y1) / Number(x1);
    const t = Math.log(Number(x) / Number(x0)) / Math.log(Number(x1) / Number(x0));
    const p = p0 + (p1 - p0) * t;
    return BigInt(Math.floor(p * Number(x)));
  }

  buyIx(user: PublicKey, lamportsIn: bigint, minRiseOut: bigint): TransactionInstruction {
    return buildBuyIx(user, lamportsIn, minRiseOut, this.acc, MINT);
  }

  sellIx(user: PublicKey, riseIn: bigint, minLamportsOut: bigint): TransactionInstruction {
    return buildSellIx(user, riseIn, minLamportsOut, this.acc, MINT);
  }

  close(): void {
    this.oracle.close();
  }
}
