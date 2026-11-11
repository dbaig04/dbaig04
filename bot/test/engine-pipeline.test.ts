// End-to-end engine tick against synthetic venues and a fake RPC that executes
// the legs on its own balances (so the sim's post-state is "real").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { loadConfig, REFERENCE_WALLET, type Config } from "../src/config.js";
import { ArbEngine } from "../src/engine/engine.js";
import { Ledger, type Realized } from "../src/engine/ledger.js";
import type { Sender, SendResult } from "../src/engine/sender.js";
import { signatureOf } from "../src/engine/sender.js";
import { atasFor } from "../src/engine/setup.js";
import { CpDlmm, LinearRise, tokenAccountInfo } from "./engine-fakes.js";

type Bal = { wsol: bigint; rise: bigint };

function chain(v: { rise: LinearRise; dlmm: CpDlmm }, user: PublicKey, bal: Bal) {
  const { wsolAta, riseAta } = atasFor(user);
  let slot = 100;
  const sims: VersionedTransaction[] = [];
  const exec = (tx: VersionedTransaction, b: Bal): { err: unknown; b: Bal } => {
    const m = tx.message;
    const keys = m.staticAccountKeys;
    const nb = { ...b };
    for (const [i, ix] of m.compiledInstructions.entries()) {
      if (keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
      const d = Buffer.from(ix.data);
      const a = d.readBigUInt64LE(1), c = d.readBigUInt64LE(9);
      const fail = { err: { InstructionError: [i, { Custom: 6405 }] }, b };
      switch (d[0]) {
        case 1: { const r = v.rise.quoteBuy(a)!; if (r < c || nb.wsol < a) return fail; nb.wsol -= a; nb.rise += r; break; }
        case 2: { const o = v.rise.quoteSell(a)!; if (o < c || nb.rise < a) return fail; nb.rise -= a; nb.wsol += o; break; }
        case 3: { const o = v.dlmm.quoteExactIn("sellRise", a)!.out; if (o < c || nb.rise < a) return fail; nb.rise -= a; nb.wsol += o; break; }
        case 6: { const inp = v.dlmm.quoteExactOut("buyRise", a)!.inp; if (inp > c || nb.wsol < inp) return fail; nb.wsol -= inp; nb.rise += a; break; }
        default: throw new Error(`unexpected ix ${d[0]}`);
      }
    }
    return { err: null, b: nb };
  };
  const conn = {
    async getSlot() { return slot; },
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      return { context: { slot }, value: ks.map((k) => (k.equals(wsolAta) ? tokenAccountInfo(bal.wsol) : k.equals(riseAta) ? tokenAccountInfo(bal.rise) : null)) };
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }; },
    async simulateTransaction(tx: VersionedTransaction, cfg: { accounts: { addresses: string[] }; sigVerify: boolean; replaceRecentBlockhash: boolean }) {
      assert.equal(cfg.sigVerify, false);
      assert.equal(cfg.replaceRecentBlockhash, true);
      assert.deepEqual(cfg.accounts.addresses, [wsolAta.toBase58(), riseAta.toBase58()]);
      sims.push(tx);
      const r = exec(tx, bal);
      const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
      return { context: { slot }, value: { err: r.err, logs: [], unitsConsumed: 300_000, accounts: r.err ? null : [acc(r.b.wsol), acc(r.b.rise)] } };
    },
  };
  return { conn, sims, exec, bump: () => { slot++; }, wsolAta, riseAta };
}

function cfgWith(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv), ...over };
}

const mkLedger = () => {
  const dir = mkdtempSync(join(tmpdir(), "eng-"));
  return { ledger: new Ledger(join(dir, "l.jsonl")), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("config: simulate by default; live needs keypair and CONFIRM_LIVE=yes", () => {
  const c = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.mode, "simulate");
  assert.equal(c.user.toBase58(), REFERENCE_WALLET);
  assert.equal(c.profitFloorLamports, 100_000n);
  assert.equal(c.ledgerPath, "data/ledger.jsonl");
  assert.throws(() => loadConfig({ MODE: "live" } as NodeJS.ProcessEnv), /KEYPAIR_PATH/);
  const dir = mkdtempSync(join(tmpdir(), "kp-"));
  try {
    const kp = Keypair.generate();
    const p = join(dir, "k.json");
    writeFileSync(p, JSON.stringify([...kp.secretKey]));
    assert.throws(() => loadConfig({ MODE: "live", KEYPAIR_PATH: p } as NodeJS.ProcessEnv), /CONFIRM_LIVE/);
    const live = loadConfig({ MODE: "live", KEYPAIR_PATH: p, CONFIRM_LIVE: "yes" } as NodeJS.ProcessEnv);
    assert.equal(live.mode, "live");
    assert.ok(live.user.equals(kp.publicKey));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => loadConfig({ MODE: "yolo" } as NodeJS.ProcessEnv), /MODE/);
});

test("simulate mode: opportunity -> sim -> final sim; never sends", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const bal = { wsol: 10_000_000_000n, rise: 0n };
  const c = chain(v, user, bal);
  const { ledger, done } = mkLedger();
  try {
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: cfgWith({ user }), ledger, log: () => {} });
    const r = await eng.tick();
    assert.equal(r.status, "simulated");
    assert.equal(c.sims.length, 2);
    assert.ok(r.sim!.ok && r.sim!.simulatedProfit! >= 100_000n);
    assert.equal(r.sim!.cuLimit, 345_000);
    const finalCu = c.sims[1].message.compiledInstructions[0].data;
    assert.equal(Buffer.from(finalCu).readUInt32LE(1), 345_000);
    const types = Ledger.read(ledger.path).map((e) => e.type);
    assert.deepEqual(types, ["opportunity", "simulation", "simulation"]);
    // unchanged slot -> no work
    assert.equal((await eng.tick()).status, "stale");
  } finally { done(); }
});

test("sim drift beyond tolerance is rejected and nothing is sent", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const c = chain(v, user, { wsol: 10_000_000_000n, rise: 0n });
  const sent: unknown[] = [];
  const sender: Sender = { name: "x", async send() { sent.push(1); throw new Error("must not send"); } };
  const { ledger, done } = mkLedger();
  try {
    const kp = Keypair.generate();
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: cfgWith({ user, mode: "live", keypair: kp }), ledger, sender, log: () => {} });
    // the pool moves against us between snapshot and simulation
    const orig = c.conn.simulateTransaction;
    c.conn.simulateTransaction = async (tx, cfg) => { v.dlmm.y = 990_000_000_000n; return orig(tx, cfg); };
    const r = await eng.tick();
    assert.equal(r.status, "sim-rejected");
    assert.equal(sent.length, 0);
    assert.match(r.sim!.reason!, /sim error|floor|deviates/);
  } finally { done(); }
});

test("live mode: sends once, records submission and actual realized outcome", async () => {
  const kp = Keypair.generate();
  const user = kp.publicKey;
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 1_060_000_000_000n, 25n) };
  const bal = { wsol: 10_000_000_000n, rise: 5n };
  const c = chain(v, user, bal);
  let inFlightSeen = false;
  let eng!: ArbEngine;
  const sender: Sender = {
    name: "fake",
    async send(tx, lvbh): Promise<SendResult> {
      inFlightSeen = eng.inFlight;
      assert.equal(lvbh, 1000);
      assert.ok(tx.signatures[0].some((x) => x !== 0));
      const r = c.exec(tx, bal);
      Object.assign(bal, r.b);
      return { signature: signatureOf(tx), status: r.err ? "failed" : "confirmed", err: r.err as never, slot: 101, broadcasts: 1 };
    },
  };
  const before = { ...bal };
  const realize = async (signature: string): Promise<Realized> => {
    // actual on-chain numbers: balance deltas + fee charged from native SOL
    const fee = 5_000n + 49_999n;
    const w = bal.wsol - before.wsol;
    return { signature, landed: true, success: true, err: null, kind: "buyThenRedeem", fee, wsolDelta: w, riseDelta: bal.rise - before.rise, nativeDelta: -fee, netLamports: w - fee };
  };
  const { ledger, done } = mkLedger();
  try {
    eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: cfgWith({ user, mode: "live", keypair: kp }), ledger, sender, realize, log: () => {} });
    const r = await eng.tick();
    assert.equal(r.status, "sent");
    assert.equal(r.plan!.direction, "buyThenRedeem");
    assert.ok(inFlightSeen);
    assert.equal(eng.inFlight, false);
    assert.ok(r.outcome!.netLamports >= 100_000n, `net ${r.outcome!.netLamports}`);
    assert.equal(eng.sessionNetLamports, r.outcome!.netLamports);
    const evs = Ledger.read(ledger.path);
    assert.deepEqual(evs.map((e) => e.type), ["opportunity", "simulation", "simulation", "submission", "outcome"]);
    const out = evs.at(-1)!;
    assert.equal(out.netLamports, r.outcome!.netLamports.toString());
    assert.equal(out.sendStatus, "confirmed");
    assert.equal(evs[3].signature, out.signature);
  } finally { done(); }
});

test("missing token accounts -> no-balance", async () => {
  const user = Keypair.generate().publicKey;
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const c = chain(v, user, { wsol: 1n, rise: 0n });
  c.conn.getMultipleAccountsInfoAndContext = async (ks: PublicKey[]) => ({ context: { slot: 100 }, value: ks.map(() => null) });
  const { ledger, done } = mkLedger();
  try {
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: cfgWith({ user }), ledger, log: () => {} });
    assert.equal((await eng.tick()).status, "no-balance");
  } finally { done(); }
});
