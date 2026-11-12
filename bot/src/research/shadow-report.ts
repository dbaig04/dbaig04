// Shadow-run analysis (public-RPC polling measurements): per-route, per-stage latency stats and, for
// every competitor MAX arb that landed during the run, whether our engine had the opportunity in a
// snapshot before the competitor's slot, how early, at what size/profit, and whether our full-tx
// simulation at that time cleared the floor.
import type { PairTickInfo } from "../engine/pair-engine.js";
import { stats, type StageStats } from "../engine/shadow.js";
import type { CompetitorArb } from "./competitors.js";

export const DIR_MAP: Record<string, string> = { buyAsellB: "buyPumpSellDlmm", buyBsellA: "buyDlmmSellPump" };
type Best = NonNullable<PairTickInfo["best"]>;

/** Route view of a tick: that route's best per direction (multi-route ticks) or the tick's own. */
function routeBest(t: PairTickInfo, route: string): Best | undefined {
  return t.routes?.[route]?.best ?? (t.routes ? undefined : t.best);
}
const planOn = (t: PairTickInfo, route: string) => !!t.plan && (t.route ?? t.plan.pair) === route;

export interface Comparison {
  route: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  feePayer: string;
  direction: string;
  competitorSolIn?: number;
  competitorNet: number;
  competitorSuccess: boolean;
  lastPreSlot?: number;
  lastPreBestExpected?: string;
  lastPreBestIn?: string;
  /** Floor-clearing plan on this route + direction in a pre-trade snapshot (within `window` slots)? */
  seen: boolean;
  firstSeenSlot?: number;
  leadSlots?: number;
  leadMs?: number;
  ourIn?: string;
  ourExpected?: string;
  /** Our final simulation on pre-trade state passed (ok and >= floor). */
  executable: boolean;
  simReasons: string[];
  postSlot?: number;
  postBestExpected?: string;
  preTicks: number;
}

export function compare(ticks: PairTickInfo[], arbs: CompetitorArb[], window = 25): Comparison[] {
  const sorted = [...ticks].sort((a, b) => a.slot - b.slot || a.wallStart - b.wallStart);
  return arbs.map((c) => {
    const route = c.route ?? "max";
    const dir = Object.entries(DIR_MAP).find(([, v]) => v === c.direction)?.[0] as keyof Best | undefined;
    const pre = sorted.filter((t) => t.slot < c.slot && t.slot >= c.slot - window);
    const lastPre = pre.at(-1);
    const best = (t?: PairTickInfo) => (t && dir ? routeBest(t, route)?.[dir] ?? undefined : undefined);
    const seenTicks = pre.filter((t) => !t.forced && planOn(t, route) && t.plan!.direction === dir);
    const first = seenTicks[0];
    const sims = seenTicks.filter((t) => t.sim);
    const post = sorted.find((t) => t.slot >= c.slot);
    return {
      route, signature: c.signature, slot: c.slot, blockTime: c.blockTime, feePayer: c.feePayer, direction: c.direction,
      competitorSolIn: c.solIn, competitorNet: c.walletSolNet, competitorSuccess: c.success,
      lastPreSlot: lastPre?.slot, lastPreBestExpected: best(lastPre)?.expectedProfit, lastPreBestIn: best(lastPre)?.grossIn,
      seen: !!first, firstSeenSlot: first?.slot,
      leadSlots: first ? c.slot - first.slot : undefined,
      leadMs: first && c.blockTime ? c.blockTime * 1000 - (first.wallDecided ?? first.wallStart) : undefined,
      ourIn: first?.plan ? String(first.plan.grossIn) : undefined, ourExpected: first?.plan ? String(first.plan.expectedProfit) : undefined,
      executable: sims.some((t) => t.sim!.ok), simReasons: [...new Set(sims.filter((t) => !t.sim!.ok).map((t) => (t.sim!.reason ?? "").slice(0, 80)))],
      postSlot: post?.slot, postBestExpected: best(post)?.expectedProfit, preTicks: pre.length,
    };
  });
}

export interface RouteSummary {
  route: string;
  stages: Record<string, StageStats>;
  forcedStages: Record<string, StageStats>;
  opportunities: number;
  simulatedOk: number;
  bestExpected: StageStats;
}

export interface ShadowSummary {
  ticks: number;
  byStatus: Record<string, number>;
  /** Shared stages (one state poll and one decision per tick covers all routes). */
  stages: Record<string, StageStats>;
  slotGap: StageStats;
  routes: RouteSummary[];
}

export function routesOf(ticks: PairTickInfo[]): string[] {
  const s = new Set<string>();
  for (const t of ticks) { for (const r of Object.keys(t.routes ?? {})) s.add(r); if (t.route) s.add(t.route); }
  return [...s].sort();
}

export function summarizeTicks(ticks: PairTickInfo[]): ShadowSummary {
  const col = (f: (t: PairTickInfo) => number | undefined, filt: (t: PairTickInfo) => boolean = () => true) => stats(ticks.filter(filt).map(f).filter((x): x is number => x !== undefined));
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i].slot - ticks[i - 1].slot);
  const byStatus: Record<string, number> = {};
  for (const t of ticks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const routes = routesOf(ticks).map((r): RouteSummary => {
    const on = (t: PairTickInfo) => planOn(t, r);
    const real = (t: PairTickInfo) => on(t) && !t.forced;
    const forced = (t: PairTickInfo) => on(t) && !!t.forced;
    const bestNet = ticks.map((t) => { const b = routeBest(t, r); const xs = [b?.buyAsellB, b?.buyBsellA].filter(Boolean).map((x) => Number(x!.expectedProfit)); return xs.length ? Math.max(...xs) : undefined; }).filter((x): x is number => x !== undefined);
    return {
      route: r,
      stages: {
        "quote: two-stage optimizer, both directions (uncached)": col((t) => (t.routes?.[r] && !t.routes[r].cached ? t.routes[r].quoteUs / 1000 : undefined)),
        "build: tx build (opportunities)": col((t) => t.buildMs, real),
        "simulate: pre-sim RTT (opportunities)": col((t) => t.preSimMs, real),
        "simulate: final-sim RTT (opportunities)": col((t) => t.finalSimMs, real),
        "data arrival -> final sim returned (opportunities)": col((t) => t.dataToSimulatedMs, real),
      },
      forcedStages: {
        "build (sub-floor latency probes)": col((t) => t.buildMs, forced),
        "pre-sim RTT (probes)": col((t) => t.preSimMs, forced),
        "final-sim RTT (probes)": col((t) => t.finalSimMs, forced),
      },
      opportunities: ticks.filter(real).length,
      simulatedOk: ticks.filter((t) => real(t) && t.sim?.ok).length,
      bestExpected: stats(bestNet),
    };
  });
  return {
    ticks: ticks.length, byStatus,
    stages: {
      "detect: state poll RTT (getSlot + getMultipleAccounts, all routes)": col((t) => t.pollMs),
      "quote: all routes (uncached ticks)": col((t) => (t.quoteUs !== undefined ? t.quoteUs / 1000 : undefined), (t) => !t.cached),
      "data arrival -> decision": col((t) => t.dataToDecisionMs),
    },
    slotGap: stats(gaps),
    routes,
  };
}

/** Opportunity ticks with no competitor arb on the same route + direction within `window` slots after. */
export function untakenOpportunities(ticks: PairTickInfo[], arbs: CompetitorArb[], window = 25) {
  const opp = ticks.filter((t) => t.plan && !t.forced);
  const untaken = opp.filter((t) => !arbs.some((a) => (a.route ?? "max") === (t.route ?? t.plan!.pair) && a.direction === DIR_MAP[t.plan!.direction] && a.slot > t.slot && a.slot <= t.slot + window));
  return { opportunityTicks: opp.length, untaken: untaken.map((t) => ({ route: t.route ?? t.plan!.pair, slot: t.slot, direction: t.plan!.direction, grossIn: String(t.plan!.grossIn), expected: String(t.plan!.expectedProfit), simOk: t.sim?.ok ?? null, simReason: t.sim?.reason })) };
}

const f = (s: StageStats, unit = "ms") => (s.n ? `${s.median} / ${s.p95} / ${s.max} ${unit} (n=${s.n})` : "n=0");
const sol = (x: string | number | undefined) => (x === undefined ? "–" : (Number(x) / 1e9).toFixed(6));

export function renderShadowMd(o: { title: string; startedAt: string; minutes: number; interim: boolean; summary: ShadowSummary; comparisons: Comparison[]; competitorTxsScanned: number; notes: string[] }): string {
  const s = o.summary;
  const L: string[] = [];
  L.push(`# ${o.title}`, "");
  L.push(`${o.interim ? "**INTERIM** (run in progress)" : "Final"} — started ${o.startedAt}, ${o.minutes.toFixed(1)} min, ${s.ticks} ticks. **All numbers are MEASURED on public-RPC polling in simulate mode** (no gRPC / shreds in this sandbox); nothing was sent.`, "");
  L.push("## Shared stages (median / p95 / max)", "", "| stage | median / p95 / max |", "|---|---|");
  for (const [k, v] of Object.entries(s.stages)) L.push(`| ${k} | ${f(v)} |`);
  L.push(`| slots between consecutive snapshots | ${f(s.slotGap, "slots")} |`, "");
  L.push(`Tick status counts: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");
  for (const r of s.routes) {
    L.push(`## Route ${r.route}`, "", "| stage | median / p95 / max |", "|---|---|");
    for (const [k, v] of Object.entries(r.stages)) L.push(`| ${k} | ${f(v)} |`);
    for (const [k, v] of Object.entries(r.forcedStages)) L.push(`| ${k} | ${f(v)} |`);
    L.push(`| best expected net per tick, either direction (lamports) | ${f(r.bestExpected, "")} |`, "");
    const c = o.comparisons.filter((x) => x.route === r.route);
    L.push(`Floor-clearing opportunities: ${r.opportunities} ticks; passing final simulations: ${r.simulatedOk}. Competitor arbs on this route during the run: ${c.length}; seen by us on pre-trade state: ${c.filter((x) => x.seen).length}; executable (our sim cleared the floor on pre-trade state): ${c.filter((x) => x.executable).length}.`, "");
    if (c.length) {
      L.push("| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | our sim | after their slot: our best |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
      for (const x of c) L.push(`| ${x.slot} | ${x.feePayer.slice(0, 6)} | ${x.direction} | ${sol(x.competitorSolIn)} | ${sol(x.competitorNet)}${x.competitorSuccess ? "" : " (failed)"} | ${x.lastPreSlot ?? "–"} (${x.lastPreSlot !== undefined ? x.slot - x.lastPreSlot : "–"}) | ${sol(x.lastPreBestExpected)} | ${x.seen ? "yes" : "no"} | ${x.seen ? `${x.leadSlots} / ${x.leadMs ?? "–"}` : "–"} | ${x.seen ? `${sol(x.ourIn)} / ${sol(x.ourExpected)}` : "–"} | ${x.seen ? (x.executable ? "ok" : `fail: ${x.simReasons.join("; ")}`) : "–"} | ${sol(x.postBestExpected)} |`);
      L.push("");
    }
  }
  L.push(`Competitor txs scanned (signatures of the DLMM pools): ${o.competitorTxsScanned}.`, "");
  for (const n of o.notes) L.push(n);
  return L.join("\n") + "\n";
}
