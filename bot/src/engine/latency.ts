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
    simulatedMs: rel(m.simulated),
    sentMs: rel(m.sent),
  };
}

/** Rolling summary (count / p50 / p90 / max of received->decision) flushed into the ledger periodically. */
export class LatencyStats {
  private decision: number[] = [];
  private bySource = new Map<string, number>();
  private since: number;
  constructor(private periodMs: number, private now: () => number = () => performance.now()) {
    this.since = now();
  }
  add(r: LatencyRecord) {
    if (r.decisionMs !== undefined) this.decision.push(r.decisionMs);
    this.bySource.set(r.source, (this.bySource.get(r.source) ?? 0) + 1);
  }
  /** Returns a summary when the period elapsed (and resets), else null. */
  maybeFlush(): Record<string, unknown> | null {
    if (this.periodMs <= 0 || this.now() - this.since < this.periodMs) return null;
    const d = [...this.decision].sort((a, b) => a - b);
    const q = (p: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : undefined);
    const out = { kind: "summary", periodMs: Math.round(this.now() - this.since), ticks: Object.fromEntries(this.bySource), decisions: d.length, decisionP50Ms: q(0.5), decisionP90Ms: q(0.9), decisionMaxMs: d.at(-1) };
    this.decision = [];
    this.bySource.clear();
    this.since = this.now();
    return out;
  }
}
