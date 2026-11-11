// Delivery: GuardedSender (simulate-before-submit, live-only, no duplicates), JitoSender
// (tip ix, tip-account cache, never sends outside live), engine hooks (risk gates,
// one-in-flight, outcome reconciliation), delivery-compare gate + cost model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig, REFERENCE_WALLET, type Config } from "../src/config.js";
import { ArbEngine } from "../src/engine/engine.js";
import { Ledger, type Realized } from "../src/engine/ledger.js";
import { RiskGuard } from "../src/engine/risk.js";
import {
  GuardedSender, JitoClient, JitoSender, SimRegistry, signatureOf, SubmitRefused, tipInstruction, type FetchLike, type Sender, type SendResult,
} from "../src/engine/sender.js";
import { AlternatingSender, assertLiveAbAllowed, costRow } from "../src/engine/delivery-compare.js";
import { atasFor } from "../src/engine/setup.js";
import type { BuiltTx } from "../src/engine/tx.js";
import { CpDlmm, LinearRise, tokenAccountInfo } from "./engine-fakes.js";

const TIP_ACCOUNTS = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

function fakeJitoFetch() {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const result = body.method === "getTipAccounts" ? TIP_ACCOUNTS : body.method === "sendBundle" ? "bundle-id-1" : null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }), text: async () => "" };
  };
  return { f, calls };
}

function signedTx(kp = Keypair.generate()) {
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  return tx;
}

const okSender = (sent: VersionedTransaction[]): Sender => ({ name: "inner", async send(tx) { sent.push(tx); return { signature: signatureOf(tx), status: "confirmed", broadcasts: 1 }; } });

test("GuardedSender: refuses outside live, unsimulated, stale-simulated and duplicate txs", async () => {
  let now = 1_000;
  const sims = new SimRegistry(() => now);
  const sent: VersionedTransaction[] = [];
  const tx = signedTx();
  await assert.rejects(new GuardedSender(okSender(sent), { mode: "simulate", sims, maxAgeMs: 3000 }).send(tx, 1), (e) => e instanceof SubmitRefused && /outside MODE=live/.test(e.message));
  const g = new GuardedSender(okSender(sent), { mode: "live", sims, maxAgeMs: 3000 });
  await assert.rejects(g.send(tx, 1), /never simulated OK/);
  sims.record(tx, true);
  now += 3001;
  await assert.rejects(g.send(tx, 1), /3001 ms old/);
  sims.record(tx, true);
  await g.send(tx, 1);
  await assert.rejects(g.send(tx, 1), /duplicate submission/);
  // a failed sim of the same message un-registers it
  const tx2 = signedTx();
  sims.record(tx2, true);
  sims.record(tx2, false);
  await assert.rejects(g.send(tx2, 1), /never simulated OK/);
  assert.equal(sent.length, 1);
});

function fakeBuilt(payer: PublicKey): BuiltTx {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions }).compileToLegacyMessage());
  return { tx, instructions, recentBlockhash: "11111111111111111111111111111111", feeLamports: 5_000n, cuLimit: 300_000 } as unknown as BuiltTx;
}

test("JitoSender.prepare: tip transfer ix to a cached random tip account, within the caps", async () => {
  const { f, calls } = fakeJitoFetch();
  const kp = Keypair.generate();
  const client = new JitoClient({ url: "https://jito.example", fetch: f });
  const j = new JitoSender({} as never, { mode: "simulate", client, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n, rand: () => 0.99 });
  const ctx = { payer: kp.publicKey, signer: kp, expectedGrossProfit: 2_000_000n, priorityFeeLamports: 50_000n, baseFeeLamports: 5_000n };
  const p = await j.prepare(fakeBuilt(kp.publicKey), ctx);
  assert.ok(!("reject" in p));
  assert.equal(p.tipLamports, 50_000n);
  assert.equal(p.tipAccount, TIP_ACCOUNTS[1]);
  const ix = p.instructions.at(-1)!;
  assert.ok(ix.programId.equals(SystemProgram.programId));
  assert.equal(ix.data.readUInt32LE(0), 2, "SystemProgram::Transfer");
  assert.equal(ix.data.readBigUInt64LE(4), 50_000n);
  assert.ok(ix.keys[0].pubkey.equals(kp.publicKey) && ix.keys[0].isSigner && ix.keys[0].isWritable);
  assert.equal(ix.keys[1].pubkey.toBase58(), TIP_ACCOUNTS[1]);
  assert.ok(p.tx.signatures[0].some((b) => b !== 0), "re-signed");
  // 10% share binds: gross 400,000 → budget 40,000 − priority 30,000 = 10,000
  const p2 = await j.prepare(fakeBuilt(kp.publicKey), { ...ctx, expectedGrossProfit: 400_000n, priorityFeeLamports: 30_000n });
  assert.ok(!("reject" in p2) && p2.tipLamports === 10_000n);
  // below Jito's 1000-lamport minimum → reject
  const p3 = await j.prepare(fakeBuilt(kp.publicKey), { ...ctx, expectedGrossProfit: 300_000n, priorityFeeLamports: 29_500n });
  assert.ok("reject" in p3);
  assert.equal(calls.filter((c) => c.method === "getTipAccounts").length, 1, "tip accounts cached");
  assert.equal(calls.filter((c) => c.method === "sendBundle").length, 0);
  assert.throws(() => tipInstruction(kp.publicKey, kp.publicKey, 999n), /minimum/);
});

test("JitoSender.prepare accepts a tip ix built by tx.ts only if it pays a real tip account", async () => {
  const { f } = fakeJitoFetch();
  const kp = Keypair.generate();
  const j = new JitoSender({} as never, { mode: "simulate", client: new JitoClient({ url: "https://j", fetch: f }), maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n });
  const withTipTo = (to: PublicKey) => {
    const b = fakeBuilt(kp.publicKey);
    const instructions = [...b.instructions, SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: 20_000n })];
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: b.recentBlockhash, instructions }).compileToLegacyMessage());
    return { ...b, tx, instructions, tipLamports: 20_000n } as BuiltTx;
  };
  const ctx = { payer: kp.publicKey, signer: null, expectedGrossProfit: 1_000_000n, priorityFeeLamports: 10_000n, baseFeeLamports: 5_000n };
  const good = await j.prepare(withTipTo(new PublicKey(TIP_ACCOUNTS[0])), ctx);
  assert.ok(!("reject" in good) && good.tipLamports === 20_000n && good.instructions.length === 3, "no second tip added");
  assert.ok("reject" in (await j.prepare(withTipTo(Keypair.generate().publicKey), ctx)));
});

test("JitoSender.send: refuses outside live; live sends one base64 bundle and resolves by signature status", async () => {
  const { f, calls } = fakeJitoFetch();
  const client = new JitoClient({ url: "https://jito.example/", fetch: f });
  const tx = signedTx();
  const opts = { client, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n, sleep: async () => {} };
  await assert.rejects(new JitoSender({} as never, { ...opts, mode: "simulate" }).send(tx, 10), /outside MODE=live/);
  assert.equal(calls.length, 0);
  let polls = 0;
  const conn = {
    async getSignatureStatuses() { polls++; return { value: [polls >= 2 ? { slot: 7, err: null, confirmationStatus: "confirmed" } : null] }; },
    async getBlockHeight() { return 1; },
  };
  const r = await new JitoSender(conn as never, { ...opts, mode: "live" }).send(tx, 10);
  assert.equal(r.status, "confirmed");
  assert.equal(r.signature, signatureOf(tx));
  const sb = calls.filter((c) => c.method === "sendBundle");
  assert.equal(sb.length, 1);
  assert.equal(sb[0].url, "https://jito.example/api/v1/bundles");
  assert.deepEqual(sb[0].params, [[Buffer.from(tx.serialize()).toString("base64")], { encoding: "base64" }]);
});

// ---------------- engine hooks ----------------

type Bal = { wsol: bigint; rise: bigint; native: bigint };

function chain(v: { rise: LinearRise; dlmm: CpDlmm }, user: PublicKey, bal: Bal) {
  const { wsolAta, riseAta } = atasFor(user);
  let slot = 100;
  const sims: VersionedTransaction[] = [];
  const exec = (tx: VersionedTransaction, b: Bal): { err: unknown; b: Bal } => {
    const keys = tx.message.staticAccountKeys;
    const nb = { ...b };
    for (const [i, ix] of tx.message.compiledInstructions.entries()) {
      const prog = keys[ix.programIdIndex];
      if (prog.equals(ComputeBudgetProgram.programId)) continue;
      const d = Buffer.from(ix.data);
      if (prog.equals(SystemProgram.programId)) { nb.native -= d.readBigUInt64LE(4); continue; }
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
    async simulateTransaction(tx: VersionedTransaction) {
      sims.push(tx);
      const r = exec(tx, bal);
      const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
      return { context: { slot }, value: { err: r.err, logs: [], unitsConsumed: 300_000, accounts: r.err ? null : [acc(r.b.wsol), acc(r.b.rise)] } };
    },
  };
  return { conn, sims, exec, bump: () => { slot++; } };
}

const venues = () => ({ rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) });

function setup(over: Partial<Config> = {}, riskOver: Partial<Config["risk"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deliv-"));
  const base = loadConfig({} as NodeJS.ProcessEnv);
  const cfg: Config = { ...base, ...over, risk: { ...base.risk, statePath: join(dir, "risk.json"), killFile: join(dir, "STOP"), pidFile: join(dir, "pid"), ...riskOver } };
  const ledger = new Ledger(join(dir, "l.jsonl"));
  const risk = new RiskGuard(cfg.risk, { log: () => {}, onHalt: (h) => ledger.append("halt", { ...h }) });
  return { cfg, ledger, risk, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("engine, simulate mode + DELIVERY=jito: tip ix is final-simulated, sendBundle is never called", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  const v = venues();
  const c = chain(v, user, { wsol: 10_000_000_000n, rise: 0n, native: 1_000_000_000n });
  const s = setup({ user, delivery: "jito" });
  const { f, calls } = fakeJitoFetch();
  const jito = new JitoSender({} as never, { mode: "simulate", client: new JitoClient({ url: "https://j", fetch: f }), maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n });
  const sendSpy = jito.send.bind(jito);
  let sendCalls = 0;
  jito.send = async (...a) => { sendCalls++; return sendSpy(...a); };
  try {
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: s.cfg, ledger: s.ledger, risk: s.risk, preparer: jito, log: () => {} });
    const r = await eng.tick();
    eng.close?.();
    assert.equal(r.status, "simulated", JSON.stringify(Ledger.read(s.ledger.path).filter((e) => e.type === "risk")));
    const final = c.sims.at(-1)!;
    const keys = final.message.staticAccountKeys;
    const last = final.message.compiledInstructions.at(-1)!;
    assert.ok(keys[last.programIdIndex].equals(SystemProgram.programId), "final simulated tx ends with the tip transfer");
    assert.ok(TIP_ACCOUNTS.includes(keys[last.accountKeyIndexes[1]].toBase58()));
    assert.equal(sendCalls, 0);
    assert.equal(calls.filter((x) => x.method === "sendBundle").length, 0);
    assert.ok(calls.every((x) => x.method === "getTipAccounts"));
  } finally { s.done(); }
});

test("engine: kill file => halted, stale snapshot => risk-rejected; nothing sent", async () => {
  const kp = Keypair.generate();
  const v = venues();
  const c = chain(v, kp.publicKey, { wsol: 10_000_000_000n, rise: 0n, native: 1_000_000_000n });
  const sent: VersionedTransaction[] = [];
  const stale = setup({ user: kp.publicKey, mode: "live", keypair: kp }, { maxStaleMs: -1 });
  try {
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: stale.cfg, ledger: stale.ledger, risk: stale.risk, sender: okSender(sent), log: () => {} });
    const r = await eng.tick();
    eng.close?.();
    assert.equal(r.status, "risk-rejected");
    assert.match(String(Ledger.read(stale.ledger.path).find((e) => e.type === "risk")!.reasons), /ms old/);
    writeFileSync(stale.cfg.risk.killFile, "x");
    c.bump();
    assert.equal((await eng.tick()).status, "halted");
    assert.equal(Ledger.read(stale.ledger.path).filter((e) => e.type === "halt")[0].reason, "estop-file");
    assert.equal(sent.length, 0);
  } finally { stale.done(); }
});

test("engine live: one tx in flight, outcome reconciled (trading / costs / residue / drift / latency), risk state updated", async () => {
  const kp = Keypair.generate();
  const v = venues();
  const bal = { wsol: 10_000_000_000n, rise: 5n, native: 1_000_000_000n };
  const c = chain(v, kp.publicKey, bal);
  const s = setup({ user: kp.publicKey, mode: "live", keypair: kp });
  let eng!: ArbEngine;
  let reentry: unknown = null;
  let fee = 0n;
  const before = { ...bal };
  const sender: Sender = {
    name: "fake-rpc",
    async send(tx): Promise<SendResult> {
      await eng.tick().then(() => { reentry = "no error"; }, (e) => { reentry = e; });
      assert.ok(s.risk.inFlight && s.risk.orphanInFlight, "in-flight claimed and persisted");
      const r = c.exec(tx, bal);
      Object.assign(bal, r.b);
      return { signature: signatureOf(tx), status: r.err ? "failed" : "confirmed", err: r.err as never, slot: 103, broadcasts: 1, firstSentAt: performance.now() };
    },
  };
  const realize = async (signature: string): Promise<Realized> => {
    const last = Ledger.read(s.ledger.path).filter((e) => e.type === "submission").at(-1)!;
    fee = BigInt(last.fee as string);
    const w = bal.wsol - before.wsol;
    const nativeDelta = -fee;
    return { signature, landed: true, success: true, err: null, kind: "mintThenSell", fee, wsolDelta: w, riseDelta: bal.rise - before.rise, nativeDelta, netLamports: w + nativeDelta };
  };
  try {
    eng = new ArbEngine({ conn: c.conn as never, ...v, cfg: s.cfg, ledger: s.ledger, risk: s.risk, sender, realize, log: () => {} });
    const r = await eng.tick();
    eng.close?.();
    assert.equal(r.status, "sent", JSON.stringify(Ledger.read(s.ledger.path).filter((e) => e.type === "risk")));
    assert.match(String(reentry), /in flight/);
    assert.ok(r.plan!.lamportsIn <= 100_000_000n, "max input 0.1 SOL");
    assert.equal(s.risk.inFlight, false);
    assert.equal(s.risk.orphanInFlight, null);
    assert.equal(s.risk.dailyExecCost, fee);
    const out = Ledger.read(s.ledger.path).filter((e) => e.type === "outcome").at(-1)!;
    assert.equal(out.delivery, "fake-rpc");
    assert.equal((out.exec as Record<string, string>).total, fee.toString());
    assert.equal((out.exec as Record<string, string>).base, "5000");
    assert.equal(out.tradingProfit, (BigInt(out.netLamports as string) + fee).toString());
    assert.deepEqual(out.drift, { wsol: "0", rise: "0", native: "0" }, "actual = final sim");
    const lat = out.latencyMs as Record<string, number>;
    for (const k of ["decision", "built", "simulated", "sent", "landed"]) assert.equal(typeof lat[k], "number", k);
    assert.ok(lat.decision <= lat.built && lat.built <= lat.simulated && lat.simulated <= lat.landed);
    // same opportunity again in the same slot (no state change): duplicate message refused before sending
    const again = await eng.tick();
    assert.notEqual(again.status, "sent");
  } finally { s.done(); }
});

test("delivery-compare: live A/B gate, cost model (RPC failures pay, Jito failures cost 0), A/B alternation", async () => {
  assert.throws(() => assertLiveAbAllowed({} as NodeJS.ProcessEnv), /MODE=live, CONFIRM_LIVE=yes, DELIVERY_COMPARE_LIVE=yes, KEYPAIR_PATH/);
  assert.throws(() => assertLiveAbAllowed({ MODE: "live", CONFIRM_LIVE: "yes", KEYPAIR_PATH: "k" } as NodeJS.ProcessEnv), /DELIVERY_COMPARE_LIVE=yes/);
  assert.doesNotThrow(() => assertLiveAbAllowed({ MODE: "live", CONFIRM_LIVE: "yes", DELIVERY_COMPARE_LIVE: "yes", KEYPAIR_PATH: "k" } as NodeJS.ProcessEnv));
  const rpc = costRow({ name: "rpc", pLand: 1, pFailGivenLand: 0.5 }, 2_000_000n);
  assert.equal(rpc.tipLamports, 0n);
  assert.equal(rpc.successCost, 55_000n);
  assert.equal(rpc.failedCost, 55_000n);
  assert.equal(rpc.evPerAttempt, 0.5 * (2_000_000 - 55_000) - 0.5 * 55_000);
  const j = costRow({ name: "jito", pLand: 1, pFailGivenLand: 0.5 }, 2_000_000n);
  assert.equal(j.tipLamports, 50_000n);
  assert.equal(j.failedCost, 0n);
  // A/B: arms alternate and each tx goes to the arm that prepared it
  const kp = Keypair.generate();
  const { f } = fakeJitoFetch();
  const used: string[] = [];
  const mk = (name: string): Sender => ({ name, async send(tx) { used.push(name); return { signature: signatureOf(tx), status: "confirmed", broadcasts: 1 }; } });
  const jito = new JitoSender({} as never, { mode: "live", client: new JitoClient({ url: "https://j", fetch: f }), maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxExecCostBpsOfProfit: 1_000n });
  jito.send = mk("jito").send;
  const ab = new AlternatingSender(mk("rpc"), jito);
  const ctx = { payer: kp.publicKey, signer: kp, expectedGrossProfit: 2_000_000n, priorityFeeLamports: 0n, baseFeeLamports: 5_000n };
  const b1 = fakeBuilt(kp.publicKey); b1.tx.sign([kp]);
  const p1 = await ab.prepare(b1, ctx);
  const p2 = await ab.prepare(fakeBuilt(kp.publicKey), ctx);
  assert.ok(!("reject" in p1) && !("reject" in p2));
  assert.equal(p1.tipLamports, 0n);
  assert.ok(p2.tipLamports > 0n);
  assert.equal((await ab.send(p2.tx, 1)).delivery, "jito");
  assert.equal((await ab.send(p1.tx, 1)).delivery, "rpc");
  assert.deepEqual(used, ["jito", "rpc"]);
});
