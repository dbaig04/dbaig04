# MAX shadow run (PumpSwap ⇄ Meteora DLMM)

**INTERIM** (run in progress) — started 2026-11-12T06:23:58.762Z, 14.0 min, 561 ticks. **All numbers are MEASURED on public-RPC polling in simulate mode** (no gRPC / shreds in this sandbox); nothing was sent.

## Shared stages (median / p95 / max)

| stage | median / p95 / max |
|---|---|
| detect: state poll RTT (getSlot + getMultipleAccounts, all routes) | 148.6 / 252 / 1013.2 ms (n=561) |
| quote: all routes (uncached ticks) | 0.215 / 0.376 / 4.567 ms (n=534) |
| data arrival -> decision | 1.5 / 2.6 / 7.3 ms (n=561) |
| slots between consecutive snapshots | 7 / 8 / 11 slots (n=560) |

Tick status counts: sim-rejected 41, no-opportunity 520.

## Route max:5nwdWt

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.113 / 0.179 / 1.891 ms (n=530) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 2.4 / 4.2 / 4.3 ms (n=32) |
| pre-sim RTT (probes) | 56.9 / 94.7 / 95.8 ms (n=32) |
| final-sim RTT (probes) | 51.1 / 119.5 / 763.9 ms (n=32) |
| best expected net per tick, either direction (lamports) | -22549 / -12080 / -6213  (n=561) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 0; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

## Route max:6PkALv

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.035 / 0.074 / 2.303 ms (n=512) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 3 / 14.8 / 14.8 ms (n=6) |
| pre-sim RTT (probes) | 60.1 / 255.6 / 255.6 ms (n=6) |
| final-sim RTT (probes) | 60.1 / 62.2 / 62.2 ms (n=6) |
| best expected net per tick, either direction (lamports) | -40231 / -16281 / -5719  (n=561) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 0; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

## Route max:H6Bcgd

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.033 / 0.134 / 4.35 ms (n=507) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 2.3 / 3.2 / 3.2 ms (n=3) |
| pre-sim RTT (probes) | 47 / 76.2 / 76.2 ms (n=3) |
| final-sim RTT (probes) | 42.1 / 81.2 / 81.2 ms (n=3) |
| best expected net per tick, either direction (lamports) | -52641 / -19666 / 10585  (n=561) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 0; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

Competitor txs scanned (signatures of the DLMM pools): 330.

## Opportunities we found that no competitor took

0 floor-clearing opportunity ticks; 0 had no competitor arb on the same route + direction within 25 slots after.

Measured here: everything in the tables. Not measured: landing (nothing is ever sent), gRPC/shred detection (not available in this sandbox).
Detection in this sandbox = public-RPC polling: getSlot + one getMultipleAccountsInfo per tick, every POLL_INTERVAL_MS. A competitor that back-runs a pool move in the same slot is invisible to a poller whose snapshots are several slots apart; the 'slots between consecutive snapshots' row bounds how often we can even observe pre-trade state.
