# MAX shadow run (PumpSwap ⇄ Meteora DLMM)

**INTERIM** (run in progress) — started 2026-11-12T06:02:42.837Z, 8.0 min, 321 ticks, simulate mode, public RPC polling (no gRPC / shreds in this sandbox).

## Latency per stage (median / p95 / max)

| stage | median / p95 / max |
|---|---|
| detect: state poll RTT (getSlot + getMultipleAccounts) | 118 / 203.2 / 910.2 ms (n=321) |
| quote: two-stage optimizer, both directions (uncached) | 0.144 / 0.276 / 2.66 ms (n=225) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> decision | 0.9 / 1.6 / 6 ms (n=321) |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (forced latency probes) | 2.4 / 4.3 / 24.1 ms (n=23) |
| pre-sim RTT (forced) | 48.8 / 82.4 / 87.8 ms (n=23) |
| final-sim RTT (forced) | 47.5 / 65.6 / 67.6 ms (n=23) |
| slots between consecutive snapshots | 7 / 8 / 10 slots (n=320) |

Tick status counts: sim-rejected 23, no-opportunity 298. Opportunities (floor-clearing plans): 0; passing simulations: 0.

## Competitor MAX arbs landed during the run vs our view

0 competitor round trips through both MAX pools (from 3 DLMM-pool txs scanned). Seen by us on pre-trade state: 0; executable (our sim passed the floor on pre-trade state): 0.


Measured here: everything in the tables. Not measured: landing (nothing is ever sent), gRPC/shred detection (not available in this sandbox).
Detection in this sandbox = public-RPC polling: getSlot + one getMultipleAccountsInfo per tick, every POLL_INTERVAL_MS. A competitor that back-runs a pool move in the same slot is invisible to a poller whose snapshots are several slots apart; the 'slots between consecutive snapshots' row bounds how often we can even observe pre-trade state.
