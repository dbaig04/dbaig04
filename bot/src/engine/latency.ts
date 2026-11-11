// Per-tick latency accounting: update received -> snapshot fed (refresh) ->
// decision (optimizer done) -> simulated (final sim done) -> sent (first
// broadcast accepted). All marks are performance.now() values; the record stores
// milliseconds relative to the update's receive time.

export interface LatencyMarks {
  /** When the newest data in the snapshot arrived (provider.lastUpdateAt), else tick start. */
  received: number;
  tickStart: number;
  refreshed?: number;
  decided?: number;
  /** Final tx (after the pre-sim, if any) built and prepared. */
  finalBuilt?: number;
  /** Ready-to-simulate/send tx built (blockhash from cache, CU limit, signed in live mode). */
  built?: number;
  /** Pre-simulation (CU measurement) returned. */
  preSimulated?: number;
  /** When the provider received the snapshot data (poll: RPC response arrival, which is after tickStart). */
  dataAt?: number;
  /** Time spent in the sources' update() for this snapshot. */
  ingestMs?: number;
  simulated?: number;
  sent?: number;
}

export interface LatencyRecord {
  slot: number;
  source: string;
  status: string;
  /** Why the tick ran: "grpc", "shred:arb", "timeout", ... */
  trigger?: string;
  /** received -> tick start (queueing: the previous tick was still busy, or the loop slept). */
  queueMs: number;
  refreshMs?: number;
  decisionMs?: number;
  /** received -> ready tx built. */
  builtMs?: number;
  /** Ingest (sources' update()) and data-arrival -> decision / -> ready tx (excludes the RPC fetch when polling). */
  ingestMs?: number;
  /** ready tx built -> pre-sim / final sim returned (RPC round trips). */
  preSimRttMs?: number;
  finalSimRttMs?: number;
  dataToDecisionMs?: number;
  dataToBuiltMs?: number;
  simulatedMs?: number;
  sentMs?: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function latencyRecord(slot: number, source: string, status: string, m: LatencyMarks, trigger?: string): LatencyRecord {
  const rel = (t?: number) => (t === undefined ? undefined : r1(t - m.received));
  return {
    slot, source, status, trigger,
    queueMs: r1(m.tickStart - m.received),
    refreshMs: m.refreshed === undefined ? undefined : r1(m.refreshed - m.tickStart),
    decisionMs: rel(m.decided),
    builtMs: rel(m.built),
    ingestMs: m.ingestMs === undefined ? undefined : r1(m.ingestMs),
    dataToDecisionMs: m.dataAt === undefined || m.decided === undefined ? undefined : r1(m.decided - m.dataAt),
    preSimRttMs: m.preSimulated === undefined || m.built === undefined ? undefined : r1(m.preSimulated - m.built),
    finalSimRttMs: m.simulated === undefined || m.finalBuilt === undefined ? undefined : r1(m.simulated - m.finalBuilt),
    dataToBuiltMs: m.dataAt === undefined || m.built === undefined ? undefined : r1(m.built - m.dataAt),
    simulatedMs: rel(m.simulated),
    sentMs: rel(m.sent),
  };
}

/** Rolling summary (count / p50 / p90 / max of received->decision) flushed into the ledger periodically. */
export class LatencyStats {
  private decision: number[] = [];
  private built: number[] = [];
  private bySource = new Map<string, number>();
  private since: number;
  constructor(private periodMs: number, private now: () => number = () => performance.now()) {
    this.since = now();
  }
  add(r: LatencyRecord) {
    if (r.decisionMs !== undefined) this.decision.push(r.decisionMs);
    if (r.builtMs !== undefined) this.built.push(r.builtMs);
    this.bySource.set(r.source, (this.bySource.get(r.source) ?? 0) + 1);
  }
  /** Returns a summary when the period elapsed (and resets), else null. */
  maybeFlush(): Record<string, unknown> | null {
    if (this.periodMs <= 0 || this.now() - this.since < this.periodMs) return null;
    const d = [...this.decision].sort((a, b) => a - b);
    const q = (p: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : undefined);
    const b = [...this.built].sort((a, c) => a - c);
    const qb = (p: number) => (b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : undefined);
    const out = { kind: "summary", periodMs: Math.round(this.now() - this.since), ticks: Object.fromEntries(this.bySource), decisions: d.length, decisionP50Ms: q(0.5), decisionP90Ms: q(0.9), decisionMaxMs: d.at(-1), builtP50Ms: qb(0.5), builtP90Ms: qb(0.9) };
    this.decision = [];
    this.built = [];
    this.bySource.clear();
    this.since = this.now();
    return out;
  }
}
