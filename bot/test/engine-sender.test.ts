import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { RpcSender, signatureOf, type SenderConnection } from "../src/engine/sender.js";

function signedTx() {
  const kp = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  return tx;
}

function fake(script: { landAfterPolls?: number; err?: unknown; expireAfterPolls?: number }) {
  let polls = 0, height = 100;
  const sends: unknown[] = [];
  const conn = {
    async sendRawTransaction(_raw: Uint8Array, opts: unknown) { sends.push(opts); return "sig"; },
    async getSignatureStatuses() {
      polls++;
      const landed = script.landAfterPolls !== undefined && polls >= script.landAfterPolls;
      return { context: { slot: 1 }, value: [landed ? { slot: 42, confirmations: 1, err: script.err ?? null, confirmationStatus: "confirmed" } : null] };
    },
    async getBlockHeight() { height += 1; return script.expireAfterPolls !== undefined && polls >= script.expireAfterPolls ? 10_000 : height; },
  } as unknown as SenderConnection;
  return { conn, sends };
}

const noSleep = async () => {};

test("sends with skipPreflight + maxRetries 0 and returns on confirmation", async () => {
  const f = fake({ landAfterPolls: 3 });
  const s = new RpcSender(f.conn, { sleep: noSleep, rebroadcastMs: 0 });
  const tx = signedTx();
  const r = await s.send(tx, 1_000);
  assert.equal(r.status, "confirmed");
  assert.equal(r.signature, signatureOf(tx));
  assert.equal(r.slot, 42);
  assert.ok(f.sends.length >= 2, "rebroadcasts while pending");
  assert.ok(f.sends.every((o) => JSON.stringify(o) === JSON.stringify({ skipPreflight: true, maxRetries: 0 })));
});

test("landed-but-failed is reported as failed with the error", async () => {
  const f = fake({ landAfterPolls: 1, err: { InstructionError: [3, { Custom: 6405 }] } });
  const r = await new RpcSender(f.conn, { sleep: noSleep }).send(signedTx(), 1_000);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.err, { InstructionError: [3, { Custom: 6405 }] });
});

test("stops at blockhash expiry", async () => {
  const f = fake({ expireAfterPolls: 4 });
  const r = await new RpcSender(f.conn, { sleep: noSleep, rebroadcastMs: 0 }).send(signedTx(), 1_000);
  assert.equal(r.status, "expired");
});

test("refuses unsigned txs", async () => {
  const kp = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [] }).compileToLegacyMessage();
  await assert.rejects(new RpcSender(fake({}).conn, { sleep: noSleep }).send(new VersionedTransaction(msg), 1), /not signed/);
});
