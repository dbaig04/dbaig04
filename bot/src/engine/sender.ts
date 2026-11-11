// Tx delivery. One implementation: plain RPC sendTransaction with
// skipPreflight (we already simulated), maxRetries 0, and our own rebroadcast
// loop until confirmation or blockhash expiry. sendRawTransaction can go to a
// separate endpoint (SEND_RPC_URL, e.g. ERPC SWQoS) while statuses are polled on
// the read RPC.
import type { Commitment, Connection, TransactionError, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

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
