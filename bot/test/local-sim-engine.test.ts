// LOCAL_SIM=shadow wiring in the pair engine: the local simulation runs next to the pre / final RPC
// simulations on the exact tx + snapshot, writes `local_simulation` rows, and never changes a
// decision (same statuses / RPC sims as without it). Fake venues use programs the simulator has not
// loaded, so every local run is a "local-refused" comparison here — the real-program path is
// covered by test/local-sim.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig, type Config } from "../src/config.js";
import { Ledger } from "../src/engine/ledger.js";
import { PairEngine } from "../src/engine/pair-engine.js";
import { LocalSimAccounts, LocalTxSimulator, type ChainContext } from "../src/engine/local-sim.js";
import { BinVenue, CpVenue, ladder, pairChain } from "./pair-fakes.js";
import { DlmmSwapVenue } from "../src/meteora/venue.js";
import { PumpSwapPool } from "../src/pumpswap/index.js";

const MAX = new PublicKey("5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump");
const c = JSON.parse(gunzipSync(readFileSync("test/fixtures/localsim/chain-context.json.gz")).toString());
const ctx: ChainContext = { slot: c.slot, rent: c.rent, knownFeatures: c.knownFeatures, features: c.features.map((f: { id: string; slot: string }) => ({ id: new PublicKey(f.id).toBuffer(), slot: f.slot })), programs: c.programs.map((p: { elf: string }) => ({ ...p, elf: Buffer.from(p.elf, "base64") })) };
const sim = new LocalTxSimulator({ context: ctx, checkIntervalMs: 0, timeoutMs: 2_000, log: () => undefined });
after(() => sim.close());

function setup(local: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "pair-ls-"));
  const ledger = new Ledger(join(dir, "l.jsonl"));
  const user = Keypair.generate().publicKey;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(MAX, user, true, TOKEN_2022_PROGRAM_ID);
  // same synthetic pools as test/pair-engine.test.ts
  const a = new CpVenue("pumpswap:fake", 600_000_000_000n, (600_000_000_000n * 1_000_000n) / 25_000n, 125n);
  const b = new BinVenue("dlmm:fake", ladder(25_000n, 30, 100n, 3_000_000_000n), 30, 100n, 2n);
  const ch = pairChain([a, b], wsolAta, tokenAta, { wsol: 1_000_000_000n, tok: 0n });
  const cfg: Config = loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv);
  const eng = new PairEngine({ conn: ch.conn as never, cfg, ledger, user, log: () => {}, pair: { name: "max", a, b, tokenMint: MAX, tokenProgram: TOKEN_2022_PROGRAM_ID }, ...(local ? { localSim: sim } : {}) });
  return { eng, a, ch, ledger, user, done: () => { eng.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("engine shadow: local sim rows for pre + final sims; decisions and RPC sims identical to LOCAL_SIM=off", async () => {
  await sim.init();
  const results: { statuses: string[]; rpcSims: number; rows: Record<string, unknown>[] }[] = [];
  for (const local of [false, true]) {
    const s = setup(local);
    try {
      const statuses: string[] = [];
      statuses.push((await s.eng.tick("timeout")).status);
      s.a.apply("sell", s.a.y / 20n); // open a gap
      s.ch.bump();
      statuses.push((await s.eng.tick("shred:arb")).status);
      s.ch.bump();
      statuses.push((await s.eng.tick()).status);
      await new Promise((r) => setTimeout(r, 200)); // comparisons are written asynchronously
      results.push({ statuses, rpcSims: s.ch.sims.length, rows: Ledger.read(s.ledger.path).filter((e) => e.type === "local_simulation") as never });
      if (local) {
        assert.ok(s.eng.localAccounts!.accounts().some((k) => k.equals(s.user)), "user wallet (fee payer) is in the live set");
      }
    } finally { s.done(); }
  }
  const [off, on] = results;
  assert.deepEqual(on.statuses, off.statuses);
  assert.deepEqual(off.statuses, ["no-opportunity", "simulated", "simulated"]);
  assert.equal(on.rpcSims, off.rpcSims, "the RPC simulation is unchanged and still runs every time");
  assert.equal(off.rows.length, 0);
  // tick 2: pre + final; tick 3: final only (CU learned)
  assert.deepEqual(on.rows.map((r) => r.stage), ["pre", "final", "final"]);
  for (const r of on.rows as { agreement: { class: string }; local: { refused?: string }; rpc: { ran: boolean }; snapshotSlot: number; timing: { rpcMs: number } }[]) {
    assert.equal(r.agreement.class, "local-refused");
    assert.match(r.local.refused!, /program not loaded/); // fake venue programs: refused, never simulated against a stub
    assert.equal(r.rpc.ran, true);
    assert.ok(r.snapshotSlot > 0 && r.timing.rpcMs >= 0);
  }
});

test("engine shadow: refused in live mode", () => {
  const cfg = { ...loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv), mode: "live" as const };
  assert.throws(() => new PairEngine({ conn: {} as never, cfg, ledger: new Ledger("/dev/null"), user: Keypair.generate().publicKey, log: () => {}, pair: { name: "max", a: new CpVenue("a", 1n, 1n, 1n), b: new CpVenue("b", 1n, 1n, 1n), tokenMint: MAX, tokenProgram: TOKEN_2022_PROGRAM_ID }, localSim: sim }), /simulation-only|live mode needs/);
  assert.throws(() => loadConfig({ LEDGER_PATH: "/dev/null", LOCAL_SIM: "shadow", MODE: "live", KEYPAIR_PATH: "/nonexistent" } as NodeJS.ProcessEnv));
  assert.equal(loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv).localSim.mode, "off");
  assert.throws(() => loadConfig({ LEDGER_PATH: "/dev/null", LOCAL_SIM: "on" } as NodeJS.ProcessEnv), /LOCAL_SIM/);
});

test("live account set: user wallet, DLMM reserves + oracle, both event authorities, learned keys; gRPC nulls not in the store are 'missing'", () => {
  const user = Keypair.generate().publicKey;
  const pump = new PumpSwapPool({ pool: "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ", tokenMint: MAX });
  const dlmm = new DlmmSwapVenue({ pool: "5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ", tokenMint: MAX });
  const la = new LocalSimAccounts([pump, dlmm], user);
  const fake = { reserveX: Keypair.generate().publicKey, reserveY: Keypair.generate().publicKey, oracle: Keypair.generate().publicKey };
  (dlmm.dlmm as unknown as { lbPair: unknown }).lbPair = fake;
  const keys = la.accounts().map((k) => k.toBase58());
  for (const k of [user, fake.reserveX, fake.reserveY, fake.oracle]) assert.ok(keys.includes(k.toBase58()));
  assert.ok(keys.includes("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"), "PumpSwap event authority");
  assert.ok(keys.includes("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6"), "DLMM event authority");
  const extra = Keypair.generate().publicKey.toBase58();
  la.learn([extra, "not-a-key"]);
  assert.ok(la.accounts().some((k) => k.toBase58() === extra));
  const present = Keypair.generate().publicKey.toBase58(), absent = Keypair.generate().publicKey.toBase58(), unseeded = Keypair.generate().publicKey.toBase58();
  la.update(7, new Map([[present, null], [absent, null], [unseeded, null]]));
  // polling snapshot: every requested key is authoritative (null = does not exist)
  assert.equal(la.snapshot().get(unseeded), null);
  assert.equal(la.snapshot().get("x"), undefined);
  // gRPC snapshot: a null the store does not hold was never seeded -> missing
  la.provider = { lastSource: "grpc", store: { has: (k) => k !== unseeded } };
  assert.equal(la.snapshot().get(absent), null);
  assert.equal(la.snapshot().get(unseeded), undefined);
  assert.equal(la.snapshot().slot, 7);
});
