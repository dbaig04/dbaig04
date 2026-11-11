// Execution-cost policy: how much priority fee and tip to pay for a trade, as a
// pure function of the expected profit before execution costs. Shared by the
// optimizer (net-profit objective), the tx builder (final min-out) and senders.
//
//   total = base + priority + tip
//   priority <= maxPriority, tip <= maxTip,
//   priority + tip <= maxShareBps of the expected profit before execution costs
//   tip = 0 unless the sender pays tips (plain RPC sender: tipEnabled = false)

export interface ExecFeePolicy {
  /** Base fee for the whole tx (5000 per signature). */
  baseFeeLamports: bigint;
  maxPriorityFeeLamports: bigint;
  maxTipLamports: bigint;
  /** priority + tip <= this share (bps) of expected profit before execution costs. 1000 = 10%. */
  maxShareBps: bigint;
  /** Sender pays a tip (Jito). false for the plain RPC sender => tip = 0. */
  tipEnabled: boolean;
  /** Fill the tip budget before the priority fee (Jito bundles). Default false: priority first. */
  tipFirst?: boolean;
}

export interface ExecFees {
  baseLamports: bigint;
  priorityLamports: bigint;
  tipLamports: bigint;
  /** base + priority + tip */
  totalLamports: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Fee/tip choice for a trade whose expected profit before execution costs is
 * `grossProfit` (lamports out − net lamports in, after protocol fees and price
 * impact). Spends the whole allowed budget (capped), priority first unless tipFirst.
 * Monotone: net = gross − total is non-decreasing in gross, so maximizing gross
 * profit also maximizes net profit.
 */
export function chooseExecutionFees(grossProfit: bigint, p: ExecFeePolicy): ExecFees {
  let budget = grossProfit > 0n ? (grossProfit * p.maxShareBps) / 10_000n : 0n;
  const maxTip = p.tipEnabled ? p.maxTipLamports : 0n;
  let priorityLamports: bigint, tipLamports: bigint;
  if (p.tipFirst) {
    tipLamports = min(maxTip, budget);
    budget -= tipLamports;
    priorityLamports = min(p.maxPriorityFeeLamports, budget);
  } else {
    priorityLamports = min(p.maxPriorityFeeLamports, budget);
    budget -= priorityLamports;
    tipLamports = min(maxTip, budget);
  }
  if (priorityLamports < 0n) priorityLamports = 0n;
  if (tipLamports < 0n) tipLamports = 0n;
  return { baseLamports: p.baseFeeLamports, priorityLamports, tipLamports, totalLamports: p.baseFeeLamports + priorityLamports + tipLamports };
}

/** Net profit after execution costs for a given gross profit. */
export function netAfterExecution(grossProfit: bigint, p: ExecFeePolicy): bigint {
  return grossProfit - chooseExecutionFees(grossProfit, p).totalLamports;
}

/**
 * Smallest gross profit whose net (after the policy's execution costs) reaches `floor`.
 * Used to skip a direction cheaply when even an optimistic estimate cannot get there.
 */
export function minGrossForNet(floor: bigint, p: ExecFeePolicy): bigint {
  // net(g) is non-decreasing, piecewise linear with slope 1 or (1 - share); binary search.
  let lo = floor + p.baseFeeLamports; // net(g) <= g - base
  if (netAfterExecution(lo, p) >= floor) return lo;
  let hi = lo + p.maxPriorityFeeLamports + p.maxTipLamports + 1n;
  while (netAfterExecution(hi, p) < floor) hi *= 2n;
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (netAfterExecution(m, p) >= floor) hi = m; else lo = m;
  }
  return hi;
}
