// Local full-transaction simulator (src/engine/local-sim.ts): offline replay of real two-leg MAX txs
// recorded from mainnet (test/fixtures/localsim: account snapshot + unsigned txs + the mainnet program
// binaries / feature set / rent of that moment), account-set completeness, sysvars, signer and
// blockhash checks, worker crash / hang containment, and the local-vs-RPC agreement classification.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { canonicalRpcError, compareSims, LocalTxSimulator, LocalSimShadow, type ChainContext, type LocalSimResult, type LocalSimSnapshot } from "../src/engine/local-sim.js";
import type { SimResult } from "../src/engine/simulate.js";
import type { LocalSimFixture } from "../src/research/local-sim-validate.js";

const DIR = "test/fixtures/localsim";
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString());

function loadContext(): ChainContext {
  const c = gz("chain-context.json.gz");
  return {
    slot: c.slot, rent: c.rent, knownFeatures: c.knownFeatures,
    features: c.features.map((f: { id: string; slot: string }) => ({ id: new PublicKey(f.id).toBuffer(), slot: f.slot })),
    programs: c.programs.map((p: { id: string; loader: string; programData?: string; deploySlot: string | null; sha256: string; elf: string }) => ({ ...p, elf: Buffer.from(p.elf, "base64") })),
  };
}

const fixtures: LocalSimFixture[] = readdirSync(DIR).filter((f) => f.startsWith("max-tx-")).map(gz);

function snapshotOf(fx: LocalSimFixture, drop: string[] = [], slot = fx.slot): LocalSimSnapshot {
  const m = new Map<string, AccountInfo<Buffer> | null>(Object.entries(fx.accounts).map(([k, a]) => [k, a ? { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data, "base64"), rentEpoch: 0 } : null]));
  for (const k of drop) m.delete(k);
  return { slot, get: (k) => (m.has(k) ? m.get(k)! : undefined) };
}

const ctx = loadContext();
const sims: LocalTxSimulator[] = [];
async function newSim(o: Partial<ConstructorParameters<typeof LocalTxSimulator>[0]> = {}) {
  const s = new LocalTxSimulator({ context: ctx, checkIntervalMs: 0, timeoutMs: 2_000, log: () => undefined, ...o });
  sims.push(s);
  await s.init();
  return s;
}
after(() => { for (const s of sims) s.close(); });

function request(fx: LocalSimFixture, c: LocalSimFixture["cases"][number], snap = snapshotOf(fx), tx = VersionedTransaction.deserialize(Buffer.from(c.tx, "base64"))) {
  return {
    tx, snapshot: snap, user: new PublicKey(fx.user), wsolAta: new PublicKey(fx.wsolAta), tokenAta: new PublicKey(fx.tokenAta),
    plan: { lamportsIn: BigInt(c.lamportsIn), lamportsOut: BigInt(c.lamportsOut) },
    params: { wsolPre: BigInt(fx.wsolPre), risePre: BigInt(fx.tokenPre), feeForUnits: () => ({ cuLimit: 600_000, fee: 5_000n }), profitFloorLamports: -(1n << 62n), toleranceLamports: 1n << 62n, toleranceBps: 0n },
    blockhash: { value: fx.blockhash, ageMs: 10 },
  };
}

test("fixtures: recorded snapshot + txs + mainnet programs are present", () => {
  assert.ok(fixtures.length >= 1);
  assert.equal(ctx.programs.length, 7);
  assert.ok(ctx.features.length > 150 && ctx.features.length <= ctx.knownFeatures);
  // SPL Token on mainnet is the upgradeable (p-token) program, not LiteSVM's bundled one
  assert.equal(ctx.programs.find((p) => p.id.startsWith("Tokenkeg"))!.loader, "BPFLoaderUpgradeab1e11111111111111111111111");
});

test("offline replay: every real two-leg MAX tx matches the venues' exact quotes to the unit; min-out + 1 fails with the program's error", async () => {
  const sim = await newSim();
  let exact = 0, neg = 0;
  for (const fx of fixtures) {
    for (const c of fx.cases) {
      const r = await sim.simulate(request(fx, c));
      assert.equal(r.refused, undefined, `${c.name}: refused ${r.refused}`);
      assert.ok(r.checks!.signersOk && r.checks!.blockhashOk, c.name);
      if (c.variant === "exact") {
        assert.ok(r.execOk, `${c.name}: ${r.reason}`);
        assert.equal(r.wsolDelta, BigInt(c.expectWsolDelta), `${c.name} Δ wSOL`);
        assert.equal(r.riseDelta, BigInt(c.expectTokenDelta), `${c.name} Δ MAX`);
        assert.ok(r.unitsConsumed! > 50_000 && r.unitsConsumed! < 600_000);
        exact++;
      } else {
        // PumpSwap: buy_exact_quote_in_v2 min base out -> 6040, sell_v2 min quote out -> 6004; DLMM swap2 -> 6003 (ExceededAmountSlippageTolerance)
        const want = c.expectFail === "dlmm" ? 6003 : c.variant === "leg1+1" ? 6040 : 6004;
        const ix = c.variant === "leg1+1" ? 2 : 3;
        assert.equal(r.errCanon, `InstructionError(${ix},Custom(${want}))`, c.name);
        assert.equal(r.execOk, false);
        neg++;
      }
      // where the recording's RPC simulation ran on unchanged state (it agreed then), it still agrees
      const rec = fx.rpc?.[c.name];
      if (rec && rec.slot !== undefined && (c.variant === "exact" ? rec.wsolDelta === c.expectWsolDelta : canonicalRpcError(rec.err) === r.errCanon)) {
        if (c.variant === "exact") assert.equal(BigInt(rec.wsolDelta!), r.wsolDelta);
        else assert.equal(canonicalRpcError(rec.err), r.errCanon);
      }
    }
  }
  assert.ok(exact >= 6 && neg >= 12, `exact ${exact} neg ${neg}`);
});

test("CU: local unitsConsumed equals the mainnet RPC simulation's where both ran on the same pool state", () => {
  // recorded during fixture capture: first case ran at +2 slots on unchanged state (agree-ok, CU equal)
  let checked = 0;
  for (const fx of fixtures) for (const c of fx.cases) {
    const rec = fx.rpc?.[c.name];
    if (c.variant === "exact" && rec?.wsolDelta === c.expectWsolDelta) { assert.ok(rec.cu! > 0); checked++; }
  }
  assert.ok(checked >= 1);
});

test("completeness: a tx account missing from the snapshot refuses the simulation (never simulated against a default account) and is reported", async () => {
  const learned: string[] = [];
  const sim = await newSim({ onMissing: (k) => learned.push(...k) });
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact" && x.route === "max:5nwdWt")!;
  const tx = VersionedTransaction.deserialize(Buffer.from(c.tx, "base64"));
  // the DLMM oracle (writable, ix account 8 of swap2) and the user's wallet (fee payer)
  const dlmmIx = tx.message.compiledInstructions.find((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58().startsWith("LBUZ"))!;
  const oracle = tx.message.staticAccountKeys[dlmmIx.accountKeyIndexes[8]].toBase58();
  for (const drop of [[oracle], [fx.user]]) {
    const r = await sim.simulate(request(fx, c, snapshotOf(fx, drop)));
    assert.ok(r.refused, "must refuse");
    assert.match(r.refused!, /accounts not in snapshot/);
    assert.ok(r.refused!.includes(drop[0]), r.refused);
    assert.equal(r.ok, false);
    assert.equal(r.execOk, false);
    assert.ok(learned.includes(drop[0]), "missing key is reported to the live set");
  }
  // an explicit null (verified non-existent on chain) is NOT missing: it is simulated as absent
  const snap = snapshotOf(fx);
  const withNull: LocalSimSnapshot = { slot: snap.slot, get: (k) => (k === oracle ? null : snap.get(k)) };
  const r2 = await sim.simulate(request(fx, c, withNull));
  assert.equal(r2.refused, undefined);
  assert.equal(r2.execOk, false, "swap with a non-existent oracle must fail");
});

test("completeness: the older venue-only fixtures (no DLMM reserves / oracle / user accounts) are refused", async () => {
  const sim = await newSim();
  const old = JSON.parse(gunzipSync(readFileSync("test/fixtures/pair/max3-468423170.json.gz")).toString()) as { slot: number; accounts: LocalSimFixture["accounts"] };
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact")!;
  const r = await sim.simulate(request(fx, c, snapshotOf({ ...fx, accounts: old.accounts }, [], old.slot)));
  assert.ok(r.refused && /accounts not in snapshot/.test(r.refused));
});

test("sysvars: Clock = snapshot slot + the snapshot Clock account's timestamp/epoch; Rent = chain rent", async () => {
  const sim = await newSim();
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact")!;
  const r = await sim.simulate(request(fx, c, snapshotOf(fx, [], fx.slot + 3)));
  assert.ok(r.execOk);
  const sv = await sim.debugRequest("sysvars");
  const clk = Buffer.from(fx.accounts["SysvarC1ock11111111111111111111111111111111"]!.data, "base64");
  assert.equal(sv.clock.slot, String(fx.slot + 3));
  assert.equal(sv.clock.unixTimestamp, clk.readBigInt64LE(32).toString());
  assert.equal(sv.clock.epoch, clk.readBigUInt64LE(16).toString());
  assert.equal(sv.clock.epochStartTimestamp, clk.readBigInt64LE(8).toString());
  assert.equal(sv.rent.lpby, ctx.rent.lpby);
  assert.equal(sv.rent.thr, ctx.rent.thr);
  assert.equal(r.checks!.unixTimestamp, clk.readBigInt64LE(32).toString());
  // no Clock in the snapshot -> refused
  const r2 = await sim.simulate(request(fx, c, snapshotOf(fx, ["SysvarC1ock11111111111111111111111111111111"])));
  assert.match(r2.refused ?? "", /Clock/);
});

test("signers / blockhash: a message whose signers are not exactly [user] or with a foreign / too old blockhash is refused", async () => {
  const sim = await newSim();
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact")!;
  const orig = VersionedTransaction.deserialize(Buffer.from(c.tx, "base64"));
  // add a second required signer: decompile, mark an extra key as signer, recompile
  const m = TransactionMessage.decompile(orig.message);
  const other = Keypair.generate().publicKey;
  m.instructions[2].keys.push({ pubkey: other, isSigner: true, isWritable: false });
  const tx2 = new VersionedTransaction(m.compileToLegacyMessage());
  const snap = snapshotOf(fx);
  const withOther: LocalSimSnapshot = { slot: snap.slot, get: (k) => (k === other.toBase58() ? null : snap.get(k)) };
  const r = await sim.simulate(request(fx, c, withOther, tx2));
  assert.equal(r.checks?.signersOk, false);
  assert.match(r.refused ?? "", /required signers/);
  const r2 = await sim.simulate({ ...request(fx, c), blockhash: { value: "11111111111111111111111111111111", ageMs: 5 } });
  assert.match(r2.refused ?? "", /blockhash/);
  const r3 = await sim.simulate({ ...request(fx, c), blockhash: { value: fx.blockhash, ageMs: 120_000 } });
  assert.match(r3.refused ?? "", /blockhash/);
});

test("stale binary: a changed deploy slot refuses every simulation until reloaded", async () => {
  const sim = await newSim();
  const fx = fixtures[0];
  sim.staleReason = "program binary stale: pAMMBay6 deploy slot 1 -> 2";
  const r = await sim.simulate(request(fx, fx.cases[0]));
  assert.match(r.refused ?? "", /stale/);
  sim.staleReason = null;
  assert.equal((await sim.simulate(request(fx, fx.cases[0]))).refused, undefined);
});

test("containment: a hung worker is killed at the deadline, a crashed worker is respawned; the bot process is unaffected", async () => {
  const sim = await newSim({ timeoutMs: 300 });
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact")!;
  const t0 = Date.now();
  await assert.rejects(sim.debugRequest("hang", 300), /timeout/);
  assert.ok(Date.now() - t0 < 2_000, "deadline enforced");
  // while respawning: refused (not simulated, not blocking)
  const during = await sim.simulate(request(fx, c));
  assert.ok(during.refused, "refused while the worker restarts");
  await sim.settled();
  assert.equal(sim.timeouts, 1);
  const ok1 = await sim.simulate(request(fx, c));
  assert.ok(ok1.execOk, String(ok1.refused ?? ok1.reason));
  await assert.rejects(sim.debugRequest("crash", 2_000), /exited/);
  await sim.settled();
  assert.equal(sim.crashes, 1);
  const ok2 = await sim.simulate(request(fx, c));
  assert.ok(ok2.execOk);
  assert.equal(ok2.wsolDelta, ok1.wsolDelta);
  assert.ok(sim.spawns >= 3);
});

test("failed txs + VM recycling: results stay exact across many failing / passing simulations; a full GC in the worker is safe", async () => {
  const sim = await newSim();
  const fx = fixtures[0];
  const exact = fx.cases.filter((x) => x.variant === "exact");
  const neg = fx.cases.filter((x) => x.variant !== "exact");
  for (let i = 0; i < 40; i++) {
    const c = i % 2 ? exact[i % exact.length] : neg[i % neg.length];
    const r = await sim.simulate(request(fx, c));
    if (c.variant === "exact") assert.equal(r.wsolDelta, BigInt(c.expectWsolDelta), c.name);
    else assert.equal(r.execOk, false);
    // litesvm@0.8.0 aborted in the first full GC after a successful BPF tx; the worker's build must not
    if (i % 10 === 5) assert.equal((await sim.debugRequest("gc")).gc, true);
  }
  assert.equal(sim.crashes, 0);
});

test("VM recycling: with a tiny recycle limit and every account resent each time, results stay exact (spare VM swapped in)", async () => {
  process.env.LOCAL_SIM_RECYCLE_SETS = "60"; // inherited by the forked worker
  let sim: LocalTxSimulator;
  try { sim = await newSim(); } finally { delete process.env.LOCAL_SIM_RECYCLE_SETS; }
  await sim.warm();
  const fx = fixtures[0];
  const exact = fx.cases.filter((x) => x.variant === "exact");
  for (let i = 0; i < 24; i++) {
    (sim as unknown as { sent: Map<string, unknown> }).sent.clear(); // force a full resend (35 accounts)
    const c = exact[i % exact.length];
    const r = await sim.simulate(request(fx, c));
    assert.equal(r.wsolDelta, BigInt(c.expectWsolDelta), `${i} ${c.name} ${r.refused ?? ""}`);
    if (i % 3 === 2) await new Promise((res) => setTimeout(res, 120)); // idle: lets the spare build
  }
  const p = await sim.debugRequest("ping");
  assert.ok(p.swaps + p.rebuilds >= 8, JSON.stringify(p));
  assert.equal(sim.crashes, 0);
});

// ---- agreement classification ----

const L = (x: Partial<LocalSimResult>): LocalSimResult => ({ ok: false, execOk: false, ms: 1, ...x });
const R = (x: Partial<SimResult>): SimResult => ({ ok: false, ...x });

test("agreement: both ok with equal Δ / both failed with the same error agree; anything else is a classified mismatch", () => {
  const okL = L({ ok: true, execOk: true, wsolDelta: -5n, riseDelta: 7n, unitsConsumed: 100 });
  const okR = R({ ok: true, slot: 10, wsolDelta: -5n, riseDelta: 7n, unitsConsumed: 100 });
  assert.deepEqual(compareSims(okL, okR, 10), { class: "agree-ok", agree: true, sameSlot: true, rpcSlotLag: 0, cuEqual: true, verdictEqual: true });
  const a2 = compareSims(okL, { ...okR, slot: 12, unitsConsumed: 101 }, 10);
  assert.equal(a2.class, "agree-ok");
  assert.equal(a2.sameSlot, false);
  assert.equal(a2.rpcSlotLag, 2);
  assert.equal(a2.cuEqual, false);
  assert.equal(compareSims(okL, { ...okR, wsolDelta: -6n }, 10).class, "mismatch-delta");
  assert.equal(compareSims(okL, { ...okR, riseDelta: 8n }, 10).class, "mismatch-delta");
  const errL = L({ errCanon: "InstructionError(3,Custom(6003))", unitsConsumed: 50 });
  const errR = R({ slot: 10, err: { InstructionError: [3, { Custom: 6003 }] }, unitsConsumed: 50 });
  assert.equal(compareSims(errL, errR, 10).class, "agree-err");
  assert.equal(compareSims(errL, R({ slot: 10, err: { InstructionError: [2, { Custom: 6040 }] } }), 10).class, "mismatch-error");
  assert.equal(compareSims(okL, errR, 10).class, "mismatch-outcome");
  assert.equal(compareSims(errL, okR, 10).class, "mismatch-outcome");
  // verdict (floor checks) can differ while execution agrees: still agree-ok, verdictEqual false
  assert.equal(compareSims(okL, { ...okR, ok: false, reason: "sim profit 1 < floor 2" }, 10).verdictEqual, false);
  // not comparable
  assert.equal(compareSims(L({ refused: "accounts not in snapshot: x" }), okR, 10).class, "local-refused");
  assert.equal(compareSims(okL, R({ reason: "rpc behind snapshot slot 10 after 400 ms" }), 10).class, "rpc-not-run");
  assert.equal(compareSims(okL, R({ reason: "rpc behind" }), 10).agree, null);
});

test("canonical errors: RPC JSON and LiteSVM forms map to the same string", () => {
  assert.equal(canonicalRpcError({ InstructionError: [3, { Custom: 6003 }] }), "InstructionError(3,Custom(6003))");
  assert.equal(canonicalRpcError({ InstructionError: [1, "ComputationalBudgetExceeded"] }), "InstructionError(1,ComputationalBudgetExceeded)");
  assert.equal(canonicalRpcError("AccountNotFound"), "AccountNotFound");
  assert.equal(canonicalRpcError({ InsufficientFundsForRent: { account_index: 4 } }), "InsufficientFundsForRent(4)");
  assert.equal(canonicalRpcError(undefined), undefined);
});

test("shadow: a local_simulation row per comparison with both results, agreement and data-arrival timings", async () => {
  const sim = await newSim();
  assert.ok(await sim.warm());
  const fx = fixtures[0];
  const c = fx.cases.find((x) => x.variant === "exact")!;
  const rows: Record<string, unknown>[] = [];
  const shadow = new LocalSimShadow(sim, { append: (t: string, d: Record<string, unknown>) => { rows.push({ type: t, ...d }); return d; } } as never);
  const dataAt = performance.now();
  const run = shadow.start(request(fx, c));
  const rpcStartedAt = performance.now();
  const rpc = R({ ok: true, slot: fx.slot, wsolDelta: BigInt(c.expectWsolDelta), riseDelta: BigInt(c.expectTokenDelta), unitsConsumed: 1, rpcBehindMs: 120 });
  await new Promise((r) => setTimeout(r, 30));
  const res = await shadow.finish(run, rpc, { pair: "max", route: c.route, direction: c.direction, stage: "final", forced: true, snapshotSlot: fx.slot, dataAt, rpcStartedAt, rpcDoneAt: performance.now() });
  assert.equal(res!.agreement.class, "agree-ok");
  assert.equal(rows.length, 1);
  const row = rows[0] as { type: string; agreement: { sameSlot: boolean }; timing: { dataToLocalMs: number; dataToRpcMs: number }; rpc: { waitMs: number }; local: { cu: number } };
  assert.equal(row.type, "local_simulation");
  assert.equal(row.agreement.sameSlot, true);
  assert.ok(row.timing.dataToLocalMs < row.timing.dataToRpcMs);
  assert.equal(row.rpc.waitMs, 120);
  assert.ok(row.local.cu > 0);
});

// ---- program loading from chain + upgrade (deploy slot change) ----

import { mkdtempSync, rmSync, readdirSync as lsdir } from "node:fs";
import { tmpdir } from "node:os";
import { LOADER_V2, UPGRADEABLE_LOADER } from "../src/engine/local-sim.js";

/** Fake chain serving the fixture binaries; `deploy` maps program id -> deploy slot; `gate` blocks full programdata reads. */
function fakeChain() {
  const deploy = new Map(ctx.programs.filter((p) => p.programData).map((p) => [p.id, BigInt(p.deploySlot!)]));
  const pdOf = new Map(ctx.programs.filter((p) => p.programData).map((p) => [p.programData!, p.id]));
  let gate: Promise<void> | null = null;
  let fullReads = 0;
  const rentData = Buffer.alloc(17); rentData.writeBigUInt64LE(BigInt(ctx.rent.lpby), 0); rentData.writeDoubleLE(ctx.rent.thr, 8); rentData[16] = ctx.rent.burn;
  const info = (owner: string, data: Buffer, executable = false) => ({ owner: new PublicKey(owner), data, executable, lamports: 1_000_000, rentEpoch: 0 });
  const conn = {
    async getSlot() { return 1; },
    async getMultipleAccountsInfo(keys: PublicKey[], cfg?: { dataSlice?: { offset: number; length: number } }) {
      const full = keys.some((k) => pdOf.has(k.toBase58())) && !cfg?.dataSlice;
      if (full) { fullReads++; if (gate) await gate; }
      return keys.map((k) => {
        const s = k.toBase58();
        const p = ctx.programs.find((x) => x.id === s);
        if (p && p.loader === LOADER_V2) return info(LOADER_V2, p.elf, true);
        if (p) { const d = Buffer.alloc(36); d.writeUInt32LE(2, 0); new PublicKey(p.programData!).toBuffer().copy(d, 4); return info(UPGRADEABLE_LOADER, d, true); }
        const id = pdOf.get(s);
        if (id) {
          const h = Buffer.alloc(45); h.writeUInt32LE(3, 0); h.writeBigUInt64LE(deploy.get(id)!, 4);
          const d = Buffer.concat([h, ctx.programs.find((x) => x.id === id)!.elf]);
          return info(UPGRADEABLE_LOADER, cfg?.dataSlice ? d.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) : d);
        }
        if (s === "SysvarRent111111111111111111111111111111111") return info("Sysvar1111111111111111111111111111111111111", rentData);
        const f = ctx.features.find((x) => new PublicKey(x.id).toBase58() === s);
        if (f) { const d = Buffer.alloc(9); d[0] = 1; d.writeBigUInt64LE(BigInt(f.slot), 1); return info("Feature111111111111111111111111111111111111", d); }
        return null;
      });
    },
  };
  return { conn, deploy, setGate: (g: Promise<void> | null) => { gate = g; }, get fullReads() { return fullReads; } };
}

test("chain load + upgrade: binaries come from programdata (cached per deploy slot); a changed deploy slot refuses until the new binary is loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-cache-"));
  try {
    const ch = fakeChain();
    const sim = new LocalTxSimulator({ conn: ch.conn as never, cacheDir: dir, checkIntervalMs: 0, timeoutMs: 2_000, log: () => undefined });
    sims.push(sim);
    await sim.init();
    assert.equal(sim.context!.features.length, ctx.features.length, "mainnet feature activations read from the feature accounts");
    assert.deepEqual(sim.context!.programs.map((p) => p.sha256), ctx.programs.map((p) => p.sha256), "same binaries as the recorded mainnet ones");
    assert.equal(lsdir(dir).length, 5, "upgradeable binaries cached by deploy slot");
    const fx = fixtures[0];
    const c = fx.cases.find((x) => x.variant === "exact")!;
    assert.ok((await sim.simulate(request(fx, c))).execOk);
    // DLMM is redeployed: the check marks the binary stale and refuses while the new one is loading
    const dlmm = ctx.programs.find((p) => p.id.startsWith("LBUZ"))!.id;
    ch.deploy.set(dlmm, ch.deploy.get(dlmm)! + 1000n);
    let release!: () => void;
    ch.setGate(new Promise<void>((r) => { release = r; }));
    const checking = sim.check();
    await new Promise((r) => setTimeout(r, 50));
    const during = await sim.simulate(request(fx, c));
    assert.match(during.refused ?? "", /program binary stale: LBUZKhRx/);
    release();
    await checking;
    assert.equal(sim.staleReason, null);
    assert.equal(sim.context!.programs.find((p) => p.id === dlmm)!.deploySlot, String(ch.deploy.get(dlmm)));
    const afterR = await sim.simulate(request(fx, c));
    assert.ok(afterR.execOk, String(afterR.refused));
    assert.equal(afterR.wsolDelta, BigInt(c.expectWsolDelta));
    // a restart with an unchanged deploy slot uses the cache (no full programdata read)
    const reads = ch.fullReads;
    const sim2 = new LocalTxSimulator({ conn: ch.conn as never, cacheDir: dir, checkIntervalMs: 0, log: () => undefined });
    sims.push(sim2);
    await sim2.init();
    assert.equal(ch.fullReads, reads);
    // checks overdue (3 intervals without a successful one) -> refuse
    const sim3 = new LocalTxSimulator({ conn: ch.conn as never, cacheDir: dir, checkIntervalMs: 60_000, log: () => undefined });
    sims.push(sim3);
    await sim3.init();
    sim3.lastCheckOkAt = Date.now() - 200_000;
    assert.match((await sim3.simulate(request(fx, c))).refused ?? "", /overdue/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
