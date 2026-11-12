// Per-transaction decoding for competitor research (pure functions over saved
// getTransaction JSON, v0/v1 aware). Everything here is derived from on-chain data only:
//   - fee payer, landed / failed, fee, priority fee (v1 transactionConfig or ComputeBudget ixs), CU
//   - System AdvanceNonceAccount ixs (durable nonce: nonce account, authority; the tx's
//     recentBlockhash field is then the nonce value)
//   - swaps: every non-wallet owner whose token accounts moved in >= 2 mints with opposite
//     signs is a pool touched by the tx; the program is the AMM inner ix whose first account
//     is that owner (PumpSwap: pool, DLMM: lb_pair). Direction from the pool's deltas.
//   - wallet deltas: native lamports, wSOL and every other mint (token balances by owner)
//   - SOL transfers from the wallet (outer + inner System Transfer) by recipient, tagged as a
//     Jito tip when the recipient is in the tip-account list passed in
//   - memo ixs (SPL Memo v1/v2) text
import bs58 from "bs58";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAMS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
export const WSOL = "So11111111111111111111111111111111111111112";
export const AMM_PROGRAMS: Record<string, string> = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "dlmm",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump-bonding",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "whirlpool",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium-cpmm",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium-amm",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora-damm-v2",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "meteora-damm-v1",
  HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq: "pancake-clmm",
  MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms: "manifest",
  BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi: "bisonfi",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
};

interface RawIx { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number | null }
interface RawTokBal { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export interface RawTxV1 {
  slot: number;
  blockTime?: number | null;
  version?: "legacy" | number;
  meta: {
    err: unknown; fee: number; preBalances: number[]; postBalances: number[];
    preTokenBalances?: RawTokBal[] | null; postTokenBalances?: RawTokBal[] | null;
    innerInstructions?: { index: number; instructions: RawIx[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    logMessages?: string[] | null; computeUnitsConsumed?: number; costUnits?: number;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[]; recentBlockhash: string; instructions: RawIx[];
      header?: { numRequiredSignatures: number };
      addressTableLookups?: { accountKey: string }[] | null;
      transactionConfig?: { priorityFee?: number; computeUnitLimit?: number; heapSize?: number; loadedAccountsDataSizeLimit?: number } | null;
    };
  };
}

export interface PoolLeg {
  pool: string;
  program: string;
  /** Δ of the pool's token accounts per mint (pool view: + = pool received). */
  deltas: Record<string, string>;
  /** What the pool sold / bought, from its deltas: e.g. "SOL->MAX" means the trader paid SOL for MAX. */
  trade: string;
}

export interface TxAnalysis {
  signature: string;
  slot: number;
  blockTime: number | null;
  version: string;
  feePayer: string;
  landed: true;
  success: boolean;
  err: unknown;
  fee: number;
  /** Priority fee in lamports: v1 config priorityFee, or ceil(CU limit × price / 1e6). */
  priorityFee: number;
  cuLimit?: number;
  cuPriceMicroLamports?: number;
  cuConsumed?: number;
  topPrograms: string[];
  innerPrograms: string[];
  nonce?: { account: string; authority: string; value: string };
  recentBlockhash: string;
  /** Pools that moved (route), in order of first appearance among inner ixs. */
  legs: PoolLeg[];
  swapped: boolean;
  mints: string[];
  /** Wallet = fee payer. Deltas in raw units; native includes −fee. */
  walletNative: number;
  walletWsol: string;
  walletTokens: Record<string, string>;
  /** wSOL Δ + native Δ (realized SOL, fee and tips included). */
  walletSolNet: number;
  /** SOL transfers from the wallet (outer + inner System Transfer), by recipient. */
  transfers: { to: string; lamports: number; inner: boolean; jitoTip: boolean }[];
  jitoTip: number;
  otherTransfers: number;
  memos: string[];
  /** Data of top-level ixs to the given program (hex), for decoding experiments. */
  programIxData: { program: string; hex: string; accounts: number }[];
  /** Accounts passed to top-level ixs with zero lamports before and after (marker accounts). */
  markerAccounts: string[];
  logsTail?: string[];
}

export function keysOf(t: RawTxV1): string[] {
  const la = t.meta?.loadedAddresses;
  return [...t.transaction.message.accountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])];
}

function computeBudget(t: RawTxV1, keys: string[]): { limit?: number; price?: number } {
  const out: { limit?: number; price?: number } = {};
  for (const ix of t.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (d[0] === 2 && d.length >= 5) out.limit = d.readUInt32LE(1);
    if (d[0] === 3 && d.length >= 9) out.price = Number(d.readBigUInt64LE(1));
  }
  return out;
}

/** System program instruction: { kind, lamports? }. */
export function decodeSystemIx(data: string): { kind: number; lamports?: bigint } {
  const d = Buffer.from(bs58.decode(data));
  if (d.length < 4) return { kind: -1 };
  const kind = d.readUInt32LE(0);
  return kind === 2 && d.length >= 12 ? { kind, lamports: d.readBigUInt64LE(4) } : { kind };
}

export function analyzeTx(t: RawTxV1, o: { jitoTipAccounts?: Set<string>; dataProgram?: string } = {}): TxAnalysis {
  const m = t.meta!;
  const msg = t.transaction.message;
  const keys = keysOf(t);
  const payer = keys[0];
  const tip = o.jitoTipAccounts ?? new Set<string>();
  const cb = computeBudget(t, keys);
  const cfg = msg.transactionConfig ?? undefined;
  const cuLimit = cfg?.computeUnitLimit ?? cb.limit;
  const priorityFee = cfg?.priorityFee ?? (cb.price !== undefined ? Math.ceil(((cuLimit ?? 200_000) * cb.price) / 1e6) : 0);
  const topPrograms = msg.instructions.map((ix) => keys[ix.programIdIndex]);
  const inner = (m.innerInstructions ?? []).flatMap((g) => g.instructions);
  const innerPrograms = [...new Set(inner.map((ix) => keys[ix.programIdIndex]))];

  // durable nonce: AdvanceNonceAccount (System ix 4) as the first instruction
  let nonce: TxAnalysis["nonce"];
  const first = msg.instructions[0];
  if (first && keys[first.programIdIndex] === SYSTEM_PROGRAM && decodeSystemIx(first.data).kind === 4)
    nonce = { account: keys[first.accounts[0]], authority: keys[first.accounts[2]], value: msg.recentBlockhash };

  // token deltas by account
  const pre = new Map<number, RawTokBal>((m.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const post = new Map<number, RawTokBal>((m.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const byOwner = new Map<string, Map<string, bigint>>();
  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(i), b = post.get(i);
    const mint = (b ?? a)!.mint, owner = (b ?? a)!.owner ?? `?${keys[i]}`;
    const d = BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
    if (d === 0n) continue;
    const mm = byOwner.get(owner) ?? new Map<string, bigint>();
    mm.set(mint, (mm.get(mint) ?? 0n) + d);
    byOwner.set(owner, mm);
  }
  // pool -> program from inner AMM ixs (first account = pool / lb_pair)
  const poolProgram = new Map<string, string>();
  const order: string[] = [];
  for (const ix of [...msg.instructions, ...inner]) {
    const p = keys[ix.programIdIndex];
    if (!AMM_PROGRAMS[p] || !ix.accounts.length) continue;
    const pool = keys[ix.accounts[0]];
    if (!poolProgram.has(pool)) { poolProgram.set(pool, AMM_PROGRAMS[p]); order.push(pool); }
  }
  const legs: PoolLeg[] = [];
  for (const [owner, mm] of byOwner) {
    if (owner === payer) continue;
    const vals = [...mm.entries()];
    const pos = vals.filter(([, v]) => v > 0n), neg = vals.filter(([, v]) => v < 0n);
    if (!pos.length || !neg.length) continue;
    const name = (mint: string) => (mint === WSOL ? "SOL" : mint.slice(0, 6));
    legs.push({
      pool: owner, program: poolProgram.get(owner) ?? "unknown",
      deltas: Object.fromEntries(vals.map(([k, v]) => [k, v.toString()])),
      trade: `${pos.map(([k]) => name(k)).join("+")}->${neg.map(([k]) => name(k)).join("+")}`,
    });
  }
  legs.sort((a, b) => (order.indexOf(a.pool) + 1 || 1e9) - (order.indexOf(b.pool) + 1 || 1e9));
  const walletTok = byOwner.get(payer) ?? new Map<string, bigint>();
  const pi = keys.indexOf(payer);
  const walletNative = m.postBalances[pi] - m.preBalances[pi];
  const walletWsol = walletTok.get(WSOL) ?? 0n;

  // SOL transfers from the wallet
  const transfers: TxAnalysis["transfers"] = [];
  const scan = (ix: RawIx, isInner: boolean) => {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM) return;
    const s = decodeSystemIx(ix.data);
    if (s.kind !== 2 || s.lamports === undefined) return;
    if (keys[ix.accounts[0]] !== payer) return;
    const to = keys[ix.accounts[1]];
    transfers.push({ to, lamports: Number(s.lamports), inner: isInner, jitoTip: tip.has(to) });
  };
  msg.instructions.forEach((ix) => scan(ix, false));
  inner.forEach((ix) => scan(ix, true));
  const ok = m.err === null || m.err === undefined;
  const jitoTip = ok ? transfers.filter((x) => x.jitoTip).reduce((a, x) => a + x.lamports, 0) : 0;
  const otherTransfers = ok ? transfers.filter((x) => !x.jitoTip).reduce((a, x) => a + x.lamports, 0) : 0;
  const memos = msg.instructions.filter((ix) => MEMO_PROGRAMS.has(keys[ix.programIdIndex])).map((ix) => Buffer.from(bs58.decode(ix.data)).toString("utf8"));
  const dataProgram = o.dataProgram;
  const programIxData = dataProgram ? msg.instructions.filter((ix) => keys[ix.programIdIndex] === dataProgram).map((ix) => ({ program: dataProgram, hex: Buffer.from(bs58.decode(ix.data)).toString("hex"), accounts: ix.accounts.length })) : [];
  const markerAccounts = [...new Set(msg.instructions.flatMap((ix) => ix.accounts))].filter((i) => m.preBalances[i] === 0 && m.postBalances[i] === 0).map((i) => keys[i]);
  return {
    signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime ?? null, version: String(t.version ?? "legacy"),
    feePayer: payer, landed: true, success: ok, err: m.err ?? null, fee: m.fee, priorityFee, cuLimit,
    cuPriceMicroLamports: cb.price, cuConsumed: m.computeUnitsConsumed, topPrograms, innerPrograms, nonce, recentBlockhash: msg.recentBlockhash,
    legs, swapped: legs.length > 0, mints: [...new Set([...byOwner.values()].flatMap((x) => [...x.keys()]))],
    walletNative, walletWsol: walletWsol.toString(), walletTokens: Object.fromEntries([...walletTok.entries()].map(([k, v]) => [k, v.toString()])),
    walletSolNet: walletNative + Number(walletWsol), transfers, jitoTip, otherTransfers, memos, programIxData, markerAccounts,
    logsTail: ok ? undefined : (m.logMessages ?? []).slice(-4),
  };
}

/** Pools of the route that are in `pools`, and whether the route is a closed SOL round trip. */
export function routeTouches(a: TxAnalysis, pools: Set<string>): string[] {
  return a.legs.filter((l) => pools.has(l.pool)).map((l) => l.pool);
}

export function quantile(xs: number[], q: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
