// Tx delivery. RpcSender (default): plain RPC sendTransaction with
// skipPreflight (we already simulated), maxRetries 0, and our own rebroadcast
// loop until confirmation or blockhash expiry. sendRawTransaction can go to a
// separate endpoint (SEND_RPC_URL, e.g. ERPC SWQoS) while statuses are polled on
// the read RPC. JitoSender (DELIVERY=jito): single-tx bundle with a tip ix.
// The engine always submits through GuardedSender (live mode only, exact
// message simulated OK within SIM_MAX_AGE_MS, no duplicate signatures).
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Commitment, type Connection, type Keypair, type TransactionError, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Mode } from "../config.js";
import type { BuiltTx } from "./tx.js";
import { chooseExecutionFees } from "./fees.js";

export type SendStatus = "confirmed" | "failed" | "expired";

export interface SendResult {
  signature: string;
  status: SendStatus;
  /** On-chain error for landed-but-failed txs. */
  err?: TransactionError | null;
  slot?: number;
  broadcasts: number;
  /** performance.now() when the first sendRawTransaction was accepted (latency accounting). */
  firstSentAt?: number;
  /** Delivery service actually used (A/B sender), else the sender's name. */
  delivery?: string;
}

export interface Sender {
  readonly name: string;
  /** Deliver a signed tx and wait until it lands, fails, or its blockhash expires. */
  send(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<SendResult>;
}

export type SenderConnection = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight">;

export interface RpcSenderOptions {
  /**
   * Where sendRawTransaction goes (e.g. ERPC's SWQoS endpoint, SEND_RPC_URL). Status
   * and block-height polling stay on the main (read) connection. Defaults to it.
   */
  sendConn?: Pick<Connection, "sendRawTransaction">;
  rebroadcastMs?: number;
  pollMs?: number;
  commitment?: Commitment;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function signatureOf(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig || sig.every((b) => b === 0)) throw new Error("tx is not signed");
  return bs58.encode(sig);
}

export class RpcSender implements Sender {
  readonly name = "rpc";
  constructor(private conn: SenderConnection, private o: RpcSenderOptions = {}) {}

  async send(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<SendResult> {
    const meta: { firstSentAt?: number } = {};
    const r = await this.sendInner(tx, lastValidBlockHeight, meta);
    return meta.firstSentAt === undefined ? r : { ...r, firstSentAt: meta.firstSentAt };
  }

  private async sendInner(tx: VersionedTransaction, lastValidBlockHeight: number, meta: { firstSentAt?: number }): Promise<SendResult> {
    const sleep = this.o.sleep ?? defaultSleep;
    const rebroadcastMs = this.o.rebroadcastMs ?? 2000;
    const pollMs = this.o.pollMs ?? 400;
    const wantFinal = this.o.commitment === "finalized";
    const signature = signatureOf(tx);
    const raw = tx.serialize();
    let broadcasts = 0;
    const sendConn = this.o.sendConn ?? this.conn;
    const broadcast = async () => {
      try {
        await sendConn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
        broadcasts++;
        meta.firstSentAt ??= performance.now();
      } catch (e) {
        this.o.log?.(`sendRawTransaction error (will retry): ${(e as Error).message}`);
      }
    };
    const check = async (): Promise<SendResult | null> => {
      const st = (await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: false })).value[0];
      if (!st) return null;
      if (st.err) return { signature, status: "failed", err: st.err, slot: st.slot, broadcasts };
      const ok = wantFinal ? st.confirmationStatus === "finalized" : st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";
      return ok ? { signature, status: "confirmed", err: null, slot: st.slot, broadcasts } : null;
    };

    await broadcast();
    let lastSend = Date.now();
    for (;;) {
      await sleep(pollMs);
      try {
        const r = await check();
        if (r) return r;
      } catch (e) {
        this.o.log?.(`status poll error: ${(e as Error).message}`);
      }
      let height: number;
      try {
        height = await this.conn.getBlockHeight("confirmed");
      } catch {
        continue;
      }
      if (height > lastValidBlockHeight) {
        // Expired: one final look (it may have landed in the last moments).
        for (let i = 0; i < 3; i++) {
          try {
            const st = (await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
            if (st?.err) return { signature, status: "failed", err: st.err, slot: st.slot, broadcasts };
            if (st && st.confirmationStatus) return { signature, status: "confirmed", err: null, slot: st.slot, broadcasts };
          } catch { /* retry */ }
          await sleep(pollMs);
        }
        return { signature, status: "expired", broadcasts };
      }
      if (Date.now() - lastSend >= rebroadcastMs) {
        await broadcast();
        lastSend = Date.now();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-submit guards, final-status resolution, and Jito bundle delivery.
// ---------------------------------------------------------------------------

/** sha256 of the serialized message (what the signature covers). */
export function messageHash(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

/** Message hashes whose simulation passed, with the time it passed (ms, Date.now()). */
export class SimRegistry {
  private ok = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  record(tx: VersionedTransaction, ok: boolean): string {
    const h = messageHash(tx);
    if (ok) this.ok.set(h, this.now());
    else this.ok.delete(h);
    if (this.ok.size > 256) for (const k of [...this.ok.keys()].slice(0, this.ok.size - 256)) this.ok.delete(k);
    return h;
  }
  /** ms since this exact message last simulated OK, or null if never. */
  ageMs(tx: VersionedTransaction): number | null {
    const t = this.ok.get(messageHash(tx));
    return t === undefined ? null : this.now() - t;
  }
}

/**
 * The only Sender the engine submits through. Refuses (throws, nothing sent) when:
 *  - not in live mode,
 *  - the exact message was not simulated OK within maxAgeMs,
 *  - the same signature was already handed to the inner sender (only the inner
 *    sender's own rebroadcast of the identical signed tx is allowed).
 */
/** Thrown when a submission is refused before anything was broadcast. */
export class SubmitRefused extends Error {}

export class GuardedSender implements Sender {
  readonly name: string;
  private sent = new Set<string>();
  constructor(private inner: Sender, private o: { mode: Mode; sims: SimRegistry; maxAgeMs: number }) {
    this.name = inner.name;
  }
  async send(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<SendResult> {
    if (this.o.mode !== "live") throw new SubmitRefused("sender: refusing to submit outside MODE=live");
    const age = this.o.sims.ageMs(tx);
    if (age === null) throw new SubmitRefused("sender: refusing tx whose exact message was never simulated OK");
    if (age > this.o.maxAgeMs) throw new SubmitRefused(`sender: refusing tx: last OK simulation is ${age} ms old (max ${this.o.maxAgeMs})`);
    const sig = signatureOf(tx);
    if (this.sent.has(sig)) throw new SubmitRefused(`sender: refusing duplicate submission of ${sig.slice(0, 16)}…`);
    this.sent.add(sig);
    return this.inner.send(tx, lastValidBlockHeight);
  }
}

export type StatusConnection = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;

/**
 * Final status of a submitted signature: poll until confirmed / failed, or until the
 * block height passes lastValidBlockHeight; then check signature status with
 * history a few more times before declaring it expired. `onPoll` runs between polls
 * (rebroadcast hook).
 */
export async function resolveSignature(
  conn: StatusConnection, signature: string, lastValidBlockHeight: number,
  o: { pollMs?: number; commitment?: Commitment; sleep?: (ms: number) => Promise<void>; onPoll?: () => Promise<void>; log?: (m: string) => void; broadcasts?: () => number } = {},
): Promise<SendResult> {
  const sleep = o.sleep ?? defaultSleep;
  const pollMs = o.pollMs ?? 400;
  const wantFinal = o.commitment === "finalized";
  const n = () => o.broadcasts?.() ?? 0;
  for (;;) {
    await sleep(pollMs);
    try {
      const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: false })).value[0];
      if (st?.err) return { signature, status: "failed", err: st.err, slot: st.slot, broadcasts: n() };
      if (st && (wantFinal ? st.confirmationStatus === "finalized" : st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))
        return { signature, status: "confirmed", err: null, slot: st.slot, broadcasts: n() };
    } catch (e) {
      o.log?.(`status poll error: ${(e as Error).message}`);
    }
    let height: number;
    try { height = await conn.getBlockHeight("confirmed"); } catch { continue; }
    if (height > lastValidBlockHeight) {
      for (let i = 0; i < 3; i++) {
        try {
          const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
          if (st?.err) return { signature, status: "failed", err: st.err, slot: st.slot, broadcasts: n() };
          if (st && st.confirmationStatus) return { signature, status: "confirmed", err: null, slot: st.slot, broadcasts: n() };
        } catch { /* retry */ }
        await sleep(pollMs);
      }
      return { signature, status: "expired", broadcasts: n() };
    }
    await o.onPoll?.();
  }
}

// ---------------- Jito ----------------

/** Jito requires >= 1000 lamports per bundle tip. */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class JitoClient {
  private tipCache: { at: number; accounts: string[] } | null = null;
  constructor(private o: { url: string; uuid?: string; fetch?: FetchLike; tipAccountsTtlMs?: number; now?: () => number }) {}

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.uuid) headers["x-jito-auth"] = this.o.uuid;
    const res = await f(`${this.o.url.replace(/\/$/, "")}${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`jito ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`jito ${method}: ${j.error.message}`);
    return j.result as T;
  }

  /** Read-only. Cached for tipAccountsTtlMs. */
  async getTipAccounts(): Promise<string[]> {
    const now = (this.o.now ?? Date.now)();
    if (this.tipCache && now - this.tipCache.at < (this.o.tipAccountsTtlMs ?? 600_000)) return this.tipCache.accounts;
    const accounts = await this.rpc<string[]>("/api/v1/getTipAccounts", "getTipAccounts", []);
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("jito getTipAccounts returned no accounts");
    for (const a of accounts) new PublicKey(a); // validate
    this.tipCache = { at: now, accounts };
    return accounts;
  }

  async randomTipAccount(rand: () => number = Math.random): Promise<PublicKey> {
    const a = await this.getTipAccounts();
    return new PublicKey(a[Math.floor(rand() * a.length) % a.length]);
  }

  /** LIVE: submits a bundle. Only JitoSender.send (live mode, behind GuardedSender) calls this. */
  async sendBundle(base64Txs: string[]): Promise<string> {
    return this.rpc<string>("/api/v1/bundles", "sendBundle", [base64Txs, { encoding: "base64" }]);
  }

  /** Read-only. */
  async getBundleStatuses(ids: string[]): Promise<unknown> {
    return this.rpc<unknown>("/api/v1/bundles", "getBundleStatuses", [ids]);
  }
}

export function tipInstruction(payer: PublicKey, tipAccount: PublicKey, lamports: bigint): TransactionInstruction {
  if (lamports < JITO_MIN_TIP_LAMPORTS) throw new Error(`jito tip ${lamports} < minimum ${JITO_MIN_TIP_LAMPORTS}`);
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports });
}

/** Max serialized tx size (bytes). */
export const PACKET_DATA_SIZE = 1232;

/** Serialized size, or null if it does not serialize (too large). */
export function txSize(tx: VersionedTransaction): number | null {
  try { return tx.serialize().length; } catch { return null; }
}

/** Rebuild the final tx with a tip transfer appended (same payer, blockhash, CU budget). Re-signs if a signer is given. */
export function withTip(b: BuiltTx, payer: PublicKey, tipIx: TransactionInstruction, signer: Keypair | null): { tx: VersionedTransaction; instructions: TransactionInstruction[] } {
  const instructions = [...b.instructions, tipIx];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: b.recentBlockhash, instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  if (signer) {
    if (!signer.publicKey.equals(payer)) throw new Error("signer does not match payer");
    tx.sign([signer]);
  }
  return { tx, instructions };
}

export interface PrepareContext {
  payer: PublicKey;
  signer: Keypair | null;
  /** lamportsOut − lamportsIn of the plan (expected profit before execution costs). */
  expectedGrossProfit: bigint;
  /** Priority fee of the built tx (fee − base). */
  priorityFeeLamports: bigint;
  baseFeeLamports: bigint;
}

/**
 * Tip for a Jito tx whose plan carried no tip budget (A/B arm): the shared fee/tip
 * policy (fees.ts chooseExecutionFees, tipEnabled, tip-first) for this gross profit,
 * limited so that the ACTUAL priority fee of the built tx + tip stays within the share
 * budget. null if below Jito's minimum. (With DELIVERY=jito the plan's own fees carry
 * the tip and tx.ts builds the tip ix; this is not used then.)
 */
export function chooseJitoTip(ctx: Pick<PrepareContext, "expectedGrossProfit" | "priorityFeeLamports" | "baseFeeLamports">, caps: { maxPriorityFeeLamports: bigint; maxTipLamports: bigint; maxExecCostBpsOfProfit: bigint }): bigint | null {
  if (ctx.expectedGrossProfit <= 0n) return null;
  let tip = chooseExecutionFees(ctx.expectedGrossProfit, {
    baseFeeLamports: ctx.baseFeeLamports, maxPriorityFeeLamports: caps.maxPriorityFeeLamports, maxTipLamports: caps.maxTipLamports,
    maxShareBps: caps.maxExecCostBpsOfProfit, tipEnabled: true, tipFirst: true,
  }).tipLamports;
  const budget = (ctx.expectedGrossProfit * caps.maxExecCostBpsOfProfit) / 10_000n - ctx.priorityFeeLamports;
  if (tip > budget) tip = budget;
  if (tip > caps.maxTipLamports) tip = caps.maxTipLamports;
  return tip >= JITO_MIN_TIP_LAMPORTS ? tip : null;
}

export interface PreparedTx {
  tx: VersionedTransaction;
  instructions: TransactionInstruction[];
  tipLamports: bigint;
  tipAccount?: string;
}

/** Turns the built arb tx into the exact tx that will be simulated (final sim) and sent. */
export interface TxPreparer {
  /** Tip receiver for plans whose execution fees include a tip (tx.ts then builds the tip ix itself). */
  tipAccount?(): Promise<PublicKey>;
  prepare(b: BuiltTx, ctx: PrepareContext): Promise<PreparedTx | { reject: string }>;
}

export interface JitoSenderOptions {
  mode: Mode;
  client: JitoClient;
  maxPriorityFeeLamports: bigint;
  maxTipLamports: bigint;
  maxExecCostBpsOfProfit: bigint;
  /** Re-send the identical bundle every N ms until resolved (0 = once). */
  resendMs?: number;
  pollMs?: number;
  commitment?: Commitment;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  rand?: () => number;
}

/**
 * DELIVERY=jito: one bundle holding the single arb tx, which carries its own tip
 * transfer to a random Jito tip account. Status is resolved on the read RPC
 * (signature status until confirmed / failed / blockhash expiry). Never falls
 * back to public RPC delivery. send() refuses unless mode === "live".
 */
export class JitoSender implements Sender, TxPreparer {
  readonly name = "jito";
  constructor(private conn: StatusConnection, private o: JitoSenderOptions) {}

  async tipAccount(): Promise<PublicKey> {
    return this.o.client.randomTipAccount(this.o.rand);
  }

  async prepare(b: BuiltTx, ctx: PrepareContext): Promise<PreparedTx | { reject: string }> {
    const builtTip = (b as BuiltTx & { tipLamports?: bigint }).tipLamports ?? 0n;
    if (builtTip > 0n) {
      // tx.ts already appended the tip (and budgeted it in the min-out): verify it, do not add another
      const accounts = new Set(await this.o.client.getTipAccounts());
      const last = b.instructions[b.instructions.length - 1];
      const ok = last && last.programId.equals(SystemProgram.programId) && last.data.length === 12 && last.data.readUInt32LE(0) === 2 &&
        last.data.readBigUInt64LE(4) === builtTip && last.keys[0]?.pubkey.equals(ctx.payer) && accounts.has(last.keys[1]?.pubkey.toBase58());
      if (!ok) return { reject: "built tx tip ix is not a transfer of the planned tip to a Jito tip account" };
      if (builtTip < JITO_MIN_TIP_LAMPORTS) return { reject: `jito tip ${builtTip} < minimum ${JITO_MIN_TIP_LAMPORTS}` };
      if (builtTip > this.o.maxTipLamports) return { reject: `jito tip ${builtTip} > max ${this.o.maxTipLamports}` };
      const size = txSize(b.tx);
      if (size === null || size > PACKET_DATA_SIZE) return { reject: `tx is ${size ?? ">limit"} bytes > ${PACKET_DATA_SIZE}` };
      return { tx: b.tx, instructions: b.instructions, tipLamports: builtTip, tipAccount: last.keys[1].pubkey.toBase58() };
    }
    // Plan carries no tip budget. Appending a tip now would NOT be covered by the on-chain
    // min-out (a landed tx could net floor − tip), so refuse instead (audit fix; previously the
    // DELIVERY=ab Jito arm appended an unbudgeted tip here).
    return { reject: "plan carries no tip budget: an in-tx Jito tip would not be covered by the on-chain min-out" };
  }

  async send(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<SendResult> {
    if (this.o.mode !== "live") throw new Error("JitoSender: refusing sendBundle outside MODE=live");
    const signature = signatureOf(tx);
    const b64 = Buffer.from(tx.serialize()).toString("base64");
    let broadcasts = 0;
    let firstSentAt: number | undefined;
    let last = 0;
    const submit = async () => {
      try {
        const id = await this.o.client.sendBundle([b64]);
        broadcasts++;
        firstSentAt ??= performance.now();
        last = Date.now();
        if (broadcasts === 1) this.o.log?.(`jito bundle ${id} (${signature.slice(0, 16)}…)`);
      } catch (e) {
        this.o.log?.(`jito sendBundle error (will retry): ${(e as Error).message}`);
      }
    };
    await submit();
    const r = await resolveSignature(this.conn, signature, lastValidBlockHeight, {
      pollMs: this.o.pollMs, commitment: this.o.commitment, sleep: this.o.sleep, log: this.o.log, broadcasts: () => broadcasts,
      onPoll: async () => {
        const every = this.o.resendMs ?? 0;
        if ((broadcasts === 0 || every > 0) && Date.now() - last >= every) await submit();
      },
    });
    return firstSentAt === undefined ? r : { ...r, firstSentAt };
  }
}
