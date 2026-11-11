// Delivery comparison: RPC (ERPC SWQoS via SEND_RPC_URL) vs Jito bundle.
//
//   npx tsx src/engine/delivery-compare.ts                 offline model + read-only market data -> src/engine/DELIVERY.md
//   npx tsx src/engine/delivery-compare.ts --offline       offline model only (no network)
//   npx tsx src/engine/delivery-compare.ts --live          GATED live A/B (never run without the user's approval):
//        refuses unless MODE=live, CONFIRM_LIVE=yes and DELIVERY_COMPARE_LIVE=yes; then runs the bot with
//        DELIVERY=ab (alternating rpc / jito per submission, all risk limits unchanged). Outcomes carry
//        `delivery`, so `report.ts` splits landing rate / cost / latency per service.
//
// Read-only calls used: getRecentPrioritizationFees (RPC), getTipAccounts (Jito), tip_floor (Jito
// bundles API, often unreachable from restricted networks). Nothing is signed or sent.
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { assertLiveAbAllowed, RISK_DEFAULTS } from "../config.js";
import { POOL_ADDRESS, RISE_MINT, RISE_PROGRAM_ID } from "../types.js";
import { chooseExecutionFees, type ExecFeePolicy } from "./fees.js";
import { JitoClient, messageHash, type PrepareContext, type PreparedTx, type Sender, type SendResult, type TxPreparer } from "./sender.js";
import type { BuiltTx } from "./tx.js";

// ---------------- gate ----------------

export { assertLiveAbAllowed };

// ---------------- A/B sender (live only, via main.ts DELIVERY=ab) ----------------

/**
 * Alternates rpc / jito per submission. The engine asks tipsNext() BEFORE optimizing, so the
 * Jito arm's plan carries a tip budget and tx.ts builds the tip ix with the tip covered by the
 * on-chain min-out (never an unbudgeted tip appended afterwards). prepare() routes a built tx
 * with a tip to the Jito arm (which verifies the tip ix) and one without a tip to the RPC arm,
 * remembering the arm by message hash; send() routes the exact tx to that arm.
 */
export class AlternatingSender implements Sender, TxPreparer {
  readonly name = "ab";
  private n = 0;
  private arm = new Map<string, "rpc" | "jito">();
  constructor(private rpc: Sender, private jito: Sender & TxPreparer) {}

  /** Whether the next submission is the Jito arm (its plan must budget a tip). */
  tipsNext(): boolean {
    return this.n % 2 === 1;
  }

  async tipAccount(): Promise<PublicKey> {
    if (!this.jito.tipAccount) throw new Error("ab: jito arm has no tip accounts");
    return this.jito.tipAccount();
  }

  async prepare(b: BuiltTx, ctx: PrepareContext): Promise<PreparedTx | { reject: string }> {
    const useJito = (b.tipLamports ?? 0n) > 0n;
    this.n++;
    const p = useJito ? await this.jito.prepare(b, ctx) : { tx: b.tx, instructions: b.instructions, tipLamports: 0n };
    if (!("reject" in p)) this.arm.set(messageHash(p.tx), useJito ? "jito" : "rpc");
    return p;
  }

  async send(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<SendResult> {
    const h = messageHash(tx);
    const a = this.arm.get(h);
    if (!a) throw new Error("ab: tx was not prepared by this sender");
    this.arm.delete(h);
    const r = await (a === "jito" ? this.jito : this.rpc).send(tx, lastValidBlockHeight);
    return { ...r, delivery: a };
  }
}

// ---------------- offline cost model ----------------

export interface ServiceModel {
  name: "rpc" | "jito";
  /** P(tx lands | submitted). Not measured for this bot: scenario input. */
  pLand: number;
  /** P(tx fails on-chain | it lands) — RPC only; a failing Jito bundle does not land. */
  pFailGivenLand: number;
}

export interface CostRow {
  service: string;
  grossLamports: bigint;
  baseLamports: bigint;
  priorityLamports: bigint;
  tipLamports: bigint;
  /** cost of a landed successful tx */
  successCost: bigint;
  /** cost of a failed attempt (RPC: landed failure pays base+priority; Jito: bundle does not land: 0) */
  failedCost: bigint;
  /** expected net per attempt = pLand·[(1−pFail)·(gross − successCost) − pFail·failedCost] */
  evPerAttempt: number;
}

export function policyFor(service: "rpc" | "jito", baseFee = 5_000n): ExecFeePolicy {
  return {
    baseFeeLamports: baseFee, maxPriorityFeeLamports: RISK_DEFAULTS.maxPriorityFeeLamports, maxTipLamports: RISK_DEFAULTS.maxTipLamports,
    maxShareBps: RISK_DEFAULTS.maxExecCostBpsOfProfit, tipEnabled: service === "jito", tipFirst: service === "jito",
  };
}

export function costRow(m: ServiceModel, gross: bigint, policy: ExecFeePolicy = policyFor(m.name)): CostRow {
  const f = chooseExecutionFees(gross, policy);
  const successCost = f.totalLamports;
  // RPC: a landed failure pays base + priority (the tip ix, if any, reverts). Jito: no landing, no cost.
  const failedCost = m.name === "rpc" ? f.baseLamports + f.priorityLamports : 0n;
  const pFail = m.name === "rpc" ? m.pFailGivenLand : 0;
  const ev = m.pLand * ((1 - pFail) * Number(gross - successCost) - pFail * Number(failedCost));
  return { service: m.name, grossLamports: gross, baseLamports: f.baseLamports, priorityLamports: f.priorityLamports, tipLamports: f.tipLamports, successCost, failedCost, evPerAttempt: ev };
}

// ---------------- read-only market data ----------------

export interface Measured {
  at: string;
  priorityFees?: { accounts: string[]; samples: number; nonZero: number; p50: number; p75: number; p90: number; max: number } | { error: string };
  tipAccounts?: { count: number } | { error: string };
  tipFloor?: unknown | { error: string };
}

const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);

export async function gatherReadOnly(rpcUrl: string, jitoUrl: string, fetchImpl: typeof globalThis.fetch): Promise<Measured> {
  const out: Measured = { at: new Date().toISOString() };
  const conn = new Connection(rpcUrl, { commitment: "confirmed", fetch: fetchImpl });
  const market = PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(RISE_MINT).toBuffer()], new PublicKey(RISE_PROGRAM_ID))[0];
  const accounts = [POOL_ADDRESS, market.toBase58()];
  try {
    const r = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.map((a) => new PublicKey(a)) });
    const xs = r.map((x) => x.prioritizationFee);
    out.priorityFees = { accounts, samples: xs.length, nonZero: xs.filter((x) => x > 0).length, p50: q(xs, 0.5), p75: q(xs, 0.75), p90: q(xs, 0.9), max: q(xs, 1) };
  } catch (e) { out.priorityFees = { error: (e as Error).message }; }
  try {
    const n = await new JitoClient({ url: jitoUrl, fetch: fetchImpl as never }).getTipAccounts();
    out.tipAccounts = { count: n.length };
  } catch (e) { out.tipAccounts = { error: (e as Error).message }; }
  try {
    const r = await fetchImpl("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
    out.tipFloor = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (e) { out.tipFloor = { error: (e as Error).message }; }
  return out;
}

// ---------------- report ----------------

const GROSS = [150_000n, 300_000n, 500_000n, 1_000_000n, 2_000_000n, 5_000_000n];
const SCENARIOS: { label: string; rpc: ServiceModel; jito: ServiceModel }[] = [
  { label: "both land equally (0.6), RPC landed-failure 2.1%", rpc: { name: "rpc", pLand: 0.6, pFailGivenLand: 0.021 }, jito: { name: "jito", pLand: 0.6, pFailGivenLand: 0 } },
  { label: "RPC lands more (0.7 vs 0.4), RPC landed-failure 2.1%", rpc: { name: "rpc", pLand: 0.7, pFailGivenLand: 0.021 }, jito: { name: "jito", pLand: 0.4, pFailGivenLand: 0 } },
  { label: "contested: Jito lands more (0.3 vs 0.6), RPC landed-failure 20%", rpc: { name: "rpc", pLand: 0.3, pFailGivenLand: 0.2 }, jito: { name: "jito", pLand: 0.6, pFailGivenLand: 0 } },
];

const L = (x: bigint) => x.toLocaleString("en-US");
const R = (x: number) => Math.round(x).toLocaleString("en-US");

export function renderMarkdown(m: Measured | null, cuLimit = 413_000): string {
  const o: string[] = [];
  o.push("# Delivery comparison: RPC (ERPC SWQoS) vs Jito bundle");
  o.push("");
  o.push("Generated by `npx tsx src/engine/delivery-compare.ts`. **Everything under \"Estimates\" is a model, not a measurement.** Landing rates for this bot were never measured: that needs the gated live A/B (`--live`), which sends real transactions and requires the user's explicit approval.");
  o.push("");
  o.push("## Cost model (exact, from the code)");
  o.push("");
  o.push("- Fees/tips come from `fees.ts` `chooseExecutionFees` with the default risk caps: priority ≤ 50,000, tip ≤ 50,000, priority + tip ≤ 10% of the expected profit before execution costs, base 5,000.");
  o.push("- **RPC** (`DELIVERY=rpc`, default): tip = 0. A landed success costs base + priority; **a landed failure also costs base + priority** (fees are charged on failure). Dropped/expired costs 0.");
  o.push("- **Jito** (`DELIVERY=jito`): the tip is a transfer inside the same tx (tip-first policy). A landed success costs base + priority + tip. **A bundle whose tx would fail does not land: cost 0** (the tip reverts with the tx in any case). Not landing costs 0.");
  o.push("- Expected net per attempt = P(land) · [(1 − P(fail|land)) · (gross − success cost) − P(fail|land) · failed cost].");
  o.push("- Size caveat (measured on the 4 saved reference-wallet arb txs): 1,079–1,178 bytes as legacy txs, System program already present; the in-tx tip adds the tip account + a transfer ix = 49 bytes → 1,128–1,227 of the 1,232-byte limit (5 bytes headroom on the largest). A route touching one more bin array would not fit; `JitoSender.prepare` then refuses (logged as a `risk` row) rather than sending. A v0 tx with a lookup table or a 2-tx bundle would remove this limit.");
  o.push("");
  o.push("## Per-trade costs by gross profit (exact for the policy)");
  o.push("");
  o.push("| gross (lamports) | RPC priority | RPC success cost | RPC failed cost | Jito priority | Jito tip | Jito success cost | Jito failed cost |");
  o.push("|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const g of GROSS) {
    const r = costRow({ name: "rpc", pLand: 1, pFailGivenLand: 0 }, g), j = costRow({ name: "jito", pLand: 1, pFailGivenLand: 0 }, g);
    o.push(`| ${L(g)} | ${L(r.priorityLamports)} | ${L(r.successCost)} | ${L(r.failedCost)} | ${L(j.priorityLamports)} | ${L(j.tipLamports)} | ${L(j.successCost)} | ${L(j.failedCost)} |`);
  }
  o.push("");
  o.push("Below ~1,000,000 lamports gross the 10% share (not the 50,000 caps) binds. Trades whose net after base + priority + tip is below 100,000 lamports are refused by the risk gate.");
  o.push("");
  o.push("## Estimates: expected net per attempt (lamports) under assumed landing rates");
  o.push("");
  o.push("P(land) and P(fail|land) below are **assumptions** (scenario inputs). The only measured number is the reference wallet's historical landed-failure rate, 2/94 = 2.1% (its own infrastructure, not this bot's).");
  o.push("");
  for (const s of SCENARIOS) {
    o.push(`### ${s.label} (ESTIMATE)`);
    o.push("");
    o.push("| gross | RPC EV | Jito EV | better |");
    o.push("|---:|---:|---:|:--|");
    for (const g of GROSS) {
      const r = costRow(s.rpc, g), j = costRow(s.jito, g);
      o.push(`| ${L(g)} | ${R(r.evPerAttempt)} | ${R(j.evPerAttempt)} | ${r.evPerAttempt >= j.evPerAttempt ? "rpc" : "jito"} |`);
    }
    o.push("");
  }
  o.push("Reading (model only): with equal landing rates the services are close. Below ~1,000,000 lamports gross both pay the same total (the 10% share binds), and Jito saves the landed-failure fee, so it edges ahead. Above that the shared policy makes the Jito arm pay priority + tip (105,000) against RPC's 55,000, so RPC wins unless on-chain failures are frequent. Inside a bundle the priority fee is largely redundant; a tip-only Jito policy would remove that gap (a decision for the fee-policy owner). Landing rate dominates every scenario, and it is unmeasured.");
  o.push("");
  o.push("## Measured (read-only, at generation time)");
  o.push("");
  o.push("- Reference wallet (saved txs in test/fixtures/engine, measured): fee 55,001 lamports per arb tx = 5,000 base + ~50,000 priority, RPC delivery, CU consumed 118k–359k, 2/94 landed arbs failed (error 6405), each costing the full 55,001.");
  if (!m) o.push("- Not gathered (`--offline`).");
  else {
    o.push(`- Time: ${m.at}`);
    const pf = m.priorityFees as Record<string, unknown> | undefined;
    if (pf && "error" in pf) o.push(`- getRecentPrioritizationFees: unavailable (${pf.error})`);
    else if (pf) {
      const p = pf as { accounts: string[]; samples: number; nonZero: number; p50: number; p75: number; p90: number; max: number };
      const lam = (micro: number) => Math.ceil((micro * cuLimit) / 1e6).toLocaleString("en-US");
      o.push(`- getRecentPrioritizationFees for the pool + RISE market (${p.accounts.join(", ")}), ${p.samples} recent slots, ${p.nonZero} non-zero: p50 ${p.p50}, p75 ${p.p75}, p90 ${p.p90}, max ${p.max} micro-lamports/CU (= ${lam(p.p50)} / ${lam(p.p75)} / ${lam(p.p90)} / ${lam(p.max)} lamports at a ${cuLimit.toLocaleString("en-US")} CU limit). This is the per-slot *minimum* fee of txs locking those accounts, a weak proxy for what is needed to land; it does not measure landing.`);
    }
    const ta = m.tipAccounts as Record<string, unknown> | undefined;
    o.push(`- Jito getTipAccounts: ${ta && "error" in ta ? `unavailable (${ta.error})` : `${(ta as { count: number }).count} tip accounts (reachable)`}`);
    const tf = m.tipFloor as Record<string, unknown> | undefined;
    o.push(`- Jito tip floor: ${tf && typeof tf === "object" && "error" in tf ? `**not measured** (unreachable: ${tf.error})` : "`" + JSON.stringify(tf).slice(0, 400) + "`"}`);
  }
  o.push("");
  o.push("## Not measured (needs the user's approval for the live A/B)");
  o.push("");
  o.push("- Landing rate, landed-failure rate and update→landed latency per service for this bot.");
  o.push("- Whether the in-tx tip at these sizes wins Jito auctions for this pool.");
  o.push("- Run (only with approval): `MODE=live KEYPAIR_PATH=… CONFIRM_LIVE=yes DELIVERY_COMPARE_LIVE=yes npx tsx src/engine/delivery-compare.ts --live`, then `npx tsx src/engine/report.ts` (the `[delivery]` line splits outcomes per service). All risk limits stay in force.");
  return o.join("\n") + "\n";
}

export async function main(args: string[]): Promise<void> {
  if (args.includes("--live")) {
    assertLiveAbAllowed(process.env);
    const here = dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "..", "main.ts")], { stdio: "inherit", env: { ...process.env, DELIVERY: "ab" } });
    process.exit(r.status ?? 1);
  }
  let measured: Measured | null = null;
  if (!args.includes("--offline")) {
    const { keepAliveFetch } = await import("../feeds/http.js");
    measured = await gatherReadOnly(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf", keepAliveFetch());
  }
  const md = renderMarkdown(measured);
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "DELIVERY.md");
  writeFileSync(outPath, md);
  console.log(md);
  console.log(`written ${outPath}`);
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
