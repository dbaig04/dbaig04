// Shadow-run recorder: per-tick pair-engine measurements (PairTickInfo) -> JSONL, plus
// rolling per-stage latency statistics (n / median / p95) and opportunity episodes
// (consecutive ticks with a feasible plan in the same direction). Read-only: it only
// observes the engine (simulate mode); nothing here can send.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PairTickInfo } from "./pair-engine.js";

export interface StageStats { n: number; median?: number; p95?: number; max?: number }

export function stats(xs: number[]): StageStats {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

export interface Episode {
  direction: string;
  firstSlot: number;
  lastSlot: number;
  firstWall: number;
  lastWall: number;
  ticks: number;
  bestExpected: string;
  simOk: number;
  simFail: number;
}

export class ShadowRecorder {
  readonly stages: Record<string, number[]> = { poll: [], quoteMs: [], build: [], preSim: [], finalSim: [], dataToDecision: [], dataToSimulated: [] };
  readonly forcedStages: Record<string, number[]> = { build: [], preSim: [], finalSim: [] };
  ticks = 0;
  byStatus: Record<string, number> = {};
  episodes: Episode[] = [];
  private open: Episode | null = null;
  constructor(readonly path: string | null, private now: () => number = Date.now) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  record(i: PairTickInfo): void {
    this.ticks++;
    this.byStatus[i.status] = (this.byStatus[i.status] ?? 0) + 1;
    const push = (k: string, v: number | undefined, into = this.stages) => { if (v !== undefined) into[k].push(v); };
    push("poll", i.pollMs);
    if (!i.cached && i.quoteUs !== undefined) push("quoteMs", i.quoteUs / 1000);
    if (i.forced) {
      push("build", i.buildMs, this.forcedStages);
      push("preSim", i.preSimMs, this.forcedStages);
      push("finalSim", i.finalSimMs, this.forcedStages);
    } else {
      push("build", i.buildMs);
      push("preSim", i.preSimMs);
      push("finalSim", i.finalSimMs);
      push("dataToSimulated", i.dataToSimulatedMs);
    }
    push("dataToDecision", i.dataToDecisionMs);
    // opportunity episodes (non-forced plans only)
    const opp = i.plan && !i.forced ? i.plan : null;
    if (opp && this.open && this.open.direction === opp.direction) {
      this.open.lastSlot = i.slot;
      this.open.lastWall = i.wallStart;
      this.open.ticks++;
      if (BigInt(opp.expectedProfit) > BigInt(this.open.bestExpected)) this.open.bestExpected = String(opp.expectedProfit);
    } else {
      if (this.open) this.episodes.push(this.open);
      this.open = opp ? { direction: opp.direction, firstSlot: i.slot, lastSlot: i.slot, firstWall: i.wallStart, lastWall: i.wallStart, ticks: 1, bestExpected: String(opp.expectedProfit), simOk: 0, simFail: 0 } : null;
    }
    if (this.open && i.sim && !i.forced) { if (i.sim.ok) this.open.simOk++; else this.open.simFail++; }
    if (this.path) appendFileSync(this.path, JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  }

  summary() {
    const s = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stats(v)]));
    return { ticks: this.ticks, byStatus: this.byStatus, stages: s(this.stages), forcedStages: s(this.forcedStages), episodes: [...this.episodes, ...(this.open ? [this.open] : [])] };
  }
}
