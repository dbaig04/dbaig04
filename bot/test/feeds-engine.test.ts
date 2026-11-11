// Engine integration with the infra layer: injected state provider, latency
// fields in the ledger, the optional hold-on-competing-arb rule, SEND_RPC_URL
// routing in RpcSender, and env config / redaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { describeConfig, loadConfig, REFERENCE_WALLET, type Config } from "../src/config.js";
import { ArbEngine, type PendingHint } from "../src/engine/engine.js";
import { Ledger } from "../src/engine/ledger.js";
import { RpcSender, type SenderConnection } from "../src/engine/sender.js";
import type { RefreshResult, StateManager, StateProvider } from "../src/engine/state.js";
import { atasFor } from "../src/engine/setup.js";
import type { StateSource } from "../src/types.js";
import { CpDlmm, LinearRise, tokenAccountInfo } from "./engine-fakes.js";

function fakeChain(v: { rise: LinearRise; dlmm: CpDlmm }, user: PublicKey, bal: { wsol: bigint; rise: bigint }) {
  const { wsolAta, riseAta } = atasFor(user);
  const sims: VersionedTransaction[] = [];
  const exec = (tx: VersionedTransaction) => {
    const nb = { ...bal };
    const keys = tx.message.staticAccountKeys;
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
      const d = Buffer.from(ix.data);
      const a = d.readBigUInt64LE(1);
      if (d[0] === 1) { nb.wsol -= a; nb.rise += v.rise.quoteBuy(a)!; }
      else if (d[0] === 2) { nb.rise -= a; nb.wsol += v.rise.quoteSell(a)!; }
      else if (d[0] === 3) { nb.rise -= a; nb.wsol += v.dlmm.quoteExactIn("sellRise", a)!.out; }
      else if (d[0] === 6) { nb.wsol -= v.dlmm.quoteExactOut("buyRise", a)!.inp; nb.rise += a; }
    }
    return nb;
  };
  const conn = {
    async getSlot() { return 100; },
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      return { context: { slot: 100 }, value: ks.map((k) => (k.equals(wsolAta) ? tokenAccountInfo(bal.wsol) : k.equals(riseAta) ? tokenAccountInfo(bal.rise) : null)) };
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      sims.push(tx);
      const b = exec(tx);
      const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
      return { context: { slot: 100 }, value: { err: null, logs: [], unitsConsumed: 300_000, accounts: [acc(b.wsol), acc(b.rise)] } };
    },
  };
  return { conn, sims };
}

/** A push-style provider: feeds a snapshot (via the polling manager's fetch) and reports an earlier receive time. */
class FakePushProvider implements StateProvider {
  readonly name = "fake-grpc";
  lastSlot = -1;
  lastUpdateAt?: number;
  lastSource?: string;
  refreshes = 0;
  constructor(private sources: StateSource[], private polling: StateManager, private receivedAgoMs: number) {}
  async refresh(): Promise<RefreshResult> {
    this.refreshes++;
    if (this.lastSlot >= 0) return { slot: this.lastSlot, updated: false };
    const { slot, infos } = await this.polling.fetch(this.polling.wantedAccounts());
    for (const s of this.sources) s.update(slot, infos);
    this.lastSlot = slot;
    this.lastUpdateAt = performance.now() - this.receivedAgoMs;
    this.lastSource = "grpc";
    return { slot, updated: true };
  }
}

const venues = () => ({ rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) });
const cfgWith = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv), ...over });
const mkLedger = () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-eng-"));
  return { ledger: new Ledger(join(dir, "l.jsonl")), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("engine uses an injected state provider and logs update->decision->simulated latency", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  const v = venues();
  const c = fakeChain(v, user, { wsol: 10_000_000_000n, rise: 0n });
  const { ledger, done } = mkLedger();
  try {
    let prov: FakePushProvider | undefined;
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: cfgWith({ user }), ledger, log: () => {}, stateProvider: (s, p) => (prov = new FakePushProvider(s, p, 7)) });
    assert.equal(eng.state, prov);
    const r = await eng.tick("grpc");
    assert.equal(r.status, "simulated");
    const evs = Ledger.read(ledger.path);
    assert.deepEqual(evs.map((e) => e.type), ["opportunity", "simulation", "simulation"]);
    const lo = evs[0].latency as Record<string, number | string>;
    assert.equal(lo.source, "grpc");
    assert.equal(lo.trigger, "grpc");
    // received 7 ms before the snapshot was handed over: queue (before tick) + refresh time
    assert.ok((lo.queueMs as number) + (lo.refreshMs as number) >= 6.5, `queue ${lo.queueMs} refresh ${lo.refreshMs}`);
    assert.ok((lo.decisionMs as number) >= (lo.queueMs as number));
    const lf = evs[2].latency as Record<string, number>;
    assert.ok(lf.simulatedMs >= lf.decisionMs);
    assert.equal((await eng.tick()).status, "stale");
  } finally { done(); }
});

const competitor: PendingHint = { competingArb: (slot) => ({ slot, signature: "5".repeat(64), feePayer: "Comp" }), summary: () => ({ arb: 1, poolSwap: 0, rise: 0 }) };

test("hold-on-competing-arb (opt-in): skips the trade without simulating; off by default", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  for (const hold of [true, false]) {
    const v = venues();
    const c = fakeChain(v, user, { wsol: 10_000_000_000n, rise: 0n });
    const { ledger, done } = mkLedger();
    try {
      const cfg = hold ? cfgWith({ user, holdOnCompetingArb: true }) : cfgWith({ user });
      assert.equal(loadConfig({} as NodeJS.ProcessEnv).holdOnCompetingArb, false);
      const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg, ledger, log: () => {}, pending: competitor });
      const r = await eng.tick();
      const evs = Ledger.read(ledger.path);
      if (hold) {
        assert.equal(r.status, "held");
        assert.equal(c.sims.length, 0);
        assert.deepEqual(evs.map((e) => e.type), ["opportunity", "hold"]);
        assert.deepEqual(evs[0].pending, { arb: 1, poolSwap: 0, rise: 0 });
      } else {
        assert.equal(r.status, "simulated");
        assert.equal(c.sims.length, 2);
      }
    } finally { done(); }
  }
});

test("RpcSender: sendRawTransaction goes to SEND_RPC_URL connection, status polling stays on the read RPC", async () => {
  const kp = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [] }).compileToV0Message());
  tx.sign([kp]);
  const readSends: unknown[] = [], sendSends: unknown[] = [];
  let polls = 0;
  const read = {
    async sendRawTransaction() { readSends.push(1); return "x"; },
    async getSignatureStatuses() { polls++; return { context: { slot: 1 }, value: [polls >= 3 ? { slot: 9, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null] }; },
    async getBlockHeight() { return 10; },
  } as unknown as SenderConnection;
  const sendConn = { async sendRawTransaction(_r: Uint8Array, o: unknown) { sendSends.push(o); return "x"; } };
  const s = new RpcSender(read, { sendConn: sendConn as never, pollMs: 1, rebroadcastMs: 0, sleep: async () => {} });
  const t0 = performance.now();
  const r = await s.send(tx, 100);
  assert.equal(r.status, "confirmed");
  assert.equal(readSends.length, 0);
  assert.ok(sendSends.length >= 2, "rebroadcast to the send endpoint until confirmed");
  assert.deepEqual(sendSends[0], { skipPreflight: true, maxRetries: 0 });
  assert.ok(r.firstSentAt! >= t0);
});

test("config: feeds are off unless their endpoints are set; tokens and URL paths are redacted", () => {
  const off = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(off.grpc, null);
  assert.equal(off.shreds, null);
  assert.equal(off.sendRpcUrl, undefined);
  assert.equal(off.mode, "simulate");
  const on = loadConfig({
    RPC_URL: "https://rpc.example.invalid/SECRETPATH?api-key=SECRET1", SEND_RPC_URL: "https://send.example.invalid/?k=SECRET2", WS_URL: "wss://ws.example.invalid",
    GRPC_ENDPOINT: "https://grpc.example.invalid", GRPC_X_TOKEN: "SECRET3", GRPC_COMMITMENT: "processed",
    SHREDSTREAM_ENDPOINT: "http://shreds.example.invalid:9999", SHREDSTREAM_SERVER_FILTER: "1", SHREDS_HOLD_ON_COMPETING_ARB: "true",
  } as NodeJS.ProcessEnv);
  assert.equal(on.grpc!.commitment, "processed");
  assert.equal(on.grpc!.xToken, "SECRET3");
  assert.equal(on.shreds!.serverFilter, true);
  assert.equal(on.holdOnCompetingArb, true);
  const d = describeConfig(on);
  const flat = JSON.stringify(d);
  assert.ok(!/SECRET/.test(flat), flat);
  assert.equal(d["grpc.xToken"], "(set)");
  assert.equal(d.rpcUrl, "https://rpc.example.invalid/…");
  assert.equal(d["shreds.endpoint"], "http://shreds.example.invalid:9999");
  assert.throws(() => loadConfig({ GRPC_COMMITMENT: "fast", GRPC_ENDPOINT: "https://x.invalid" } as NodeJS.ProcessEnv), /GRPC_COMMITMENT/);
  assert.throws(() => loadConfig({ GRPC_ENDPOINT: "grpc.example" } as NodeJS.ProcessEnv), /GRPC_ENDPOINT/);
});
