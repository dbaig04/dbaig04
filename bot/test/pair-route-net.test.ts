// Route selection ranks on the FINAL conservative net (expected profit after execution costs minus
// the min-out pad), not on expected profit alone: a route whose sell leg has a large rebate at risk
// (pad) must lose to a route with lower expected profit but a higher guaranteed net.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Ledger } from "../src/engine/ledger.js";
import { PairEngine } from "../src/engine/pair-engine.js";
import { conservativeNet, type PairPlan } from "../src/engine/pair-optimizer.js";
import { loadConfig, type Config } from "../src/config.js";
import { BinVenue, CpVenue, ladder, pairChain } from "./pair-fakes.js";

const MAX = new PublicKey("5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump");
const cp = (p: bigint, sol = 600_000_000_000n, fee = 125n) => new CpVenue("pumpswap:fake", sol, (sol * 1_000_000n) / p, fee);
const bins = (p: bigint, depth = 3_000_000_000n, fee = 100n, rebate = 2n) => new BinVenue("dlmm:fake", ladder(p, 30, 100n, depth), 30, fee, rebate);
const cfgWith = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv), ...over });

function run(pad: bigint | null) {
  const dir = mkdtempSync(join(tmpdir(), "pair-net-"));
  const ledger = new Ledger(join(dir, "l.jsonl"));
  const user = Keypair.generate().publicKey;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(MAX, user, true, TOKEN_2022_PROGRAM_ID);
  const a = cp(25_000n), b1 = bins(24_000n), b2 = bins(23_000n);
  for (const v of [a, b1, b2]) v.accounts = () => [];
  // b2 is the higher-expected-profit route; give its legs a constant rebate-at-risk pad
  // (default for a buy leg is the whole SOL rebate at risk; keep that and add `pad` on top)
  if (pad !== null) (b2 as unknown as { rebateAtRisk: (side: string, amountIn: bigint, q: { netIn: bigint }) => bigint }).rebateAtRisk =
    (side, amountIn, q) => (side === "buy" ? amountIn - q.netIn : 0n) + pad;
  const ch = pairChain([a, b1, b2], wsolAta, tokenAta, { wsol: 1_000_000_000n, tok: 0n });
  const eng = new PairEngine({
    conn: ch.conn as never, cfg: cfgWith(), ledger, user, log: () => {},
    pair: { name: "max", a, b: b1, routes: [{ name: "max:b1", a, b: b1 }, { name: "max:b2", a, b: b2 }], tokenMint: MAX, tokenProgram: TOKEN_2022_PROGRAM_ID },
  });
  return { eng, cleanup: () => { eng.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("route choice: a large min-out pad makes the otherwise-best route lose to a higher conservative net", async () => {
  // baseline: no pad, b2 wins on expected profit
  const base = run(null);
  let b2Plan: PairPlan, b1Net: bigint;
  try {
    const r = await base.eng.tick();
    assert.equal(r.plan!.pair, "max:b2");
    b2Plan = r.plan!;
  } finally { base.cleanup(); }
  // b1's best conservative net from a run where b2 is made infeasible (huge pad)
  const only1 = run(10n ** 15n);
  try {
    const r = await only1.eng.tick();
    assert.equal(r.plan!.pair, "max:b1");
    b1Net = conservativeNet(r.plan!);
  } finally { only1.cleanup(); }
  assert.ok(conservativeNet(b2Plan) > b1Net, "fixture: b2 must beat b1 without a pad");
  // pad b2 so that its conservative net falls just below b1's while its expected profit is unchanged
  const pad = conservativeNet(b2Plan) - b1Net + 1_000n;
  const padded = run(pad);
  try {
    const r = await padded.eng.tick();
    assert.equal(r.plan!.pair, "max:b1", "must rank routes on conservative net, not expected profit");
  } finally { padded.cleanup(); }
});
