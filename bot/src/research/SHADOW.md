# MAX shadow run (PumpSwap ⇄ Meteora DLMM)

Final — started 2026-11-12T06:23:58.762Z, 36.0 min, 1439 ticks. **All numbers are MEASURED on public-RPC polling in simulate mode** (no gRPC / shreds in this sandbox); nothing was sent.

## Shared stages (median / p95 / max)

| stage | median / p95 / max |
|---|---|
| detect: state poll RTT (getSlot + getMultipleAccounts, all routes) | 150.2 / 258.5 / 1688.5 ms (n=1439) |
| quote: all routes (uncached ticks) | 0.228 / 0.413 / 4.567 ms (n=1359) |
| data arrival -> decision | 1.4 / 2.3 / 7.3 ms (n=1439) |
| slots between consecutive snapshots | 7 / 8 / 14 slots (n=1438) |

Tick status counts: sim-rejected 103, no-opportunity 1336.

## Route max:5nwdWt

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.1 / 0.156 / 1.891 ms (n=1351) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 2.2 / 3.6 / 4.3 ms (n=83) |
| pre-sim RTT (probes) | 57.5 / 95.2 / 102.3 ms (n=83) |
| final-sim RTT (probes) | 54.4 / 99.8 / 763.9 ms (n=83) |
| best expected net per tick, either direction (lamports) | -21983 / -11485 / -5882  (n=1439) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 0; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

## Route max:6PkALv

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.028 / 0.06 / 2.303 ms (n=1305) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 2.9 / 14.8 / 14.8 ms (n=14) |
| pre-sim RTT (probes) | 51.1 / 255.6 / 255.6 ms (n=14) |
| final-sim RTT (probes) | 54 / 732.6 / 732.6 ms (n=14) |
| best expected net per tick, either direction (lamports) | -36119 / -15576 / -5297  (n=1439) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 2; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | our sim | after their slot: our best |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 468423969 | 8L2y55 | buyPumpSellDlmm | 0.048473 | 0.000020 | 468423966 (3) | -0.000027 | no | – | – | – | -0.000021 |
| 468424072 | 55rBmc | buyDlmmSellPump | 0.235037 | 0.000033 | 468424069 (3) | -0.000017 | no | – | – | – | -0.000006 |

## Route max:H6Bcgd

| stage | median / p95 / max |
|---|---|
| quote: two-stage optimizer, both directions (uncached) | 0.096 / 0.208 / 4.35 ms (n=1294) |
| build: tx build (opportunities) | n=0 |
| simulate: pre-sim RTT (opportunities) | n=0 |
| simulate: final-sim RTT (opportunities) | n=0 |
| data arrival -> final sim returned (opportunities) | n=0 |
| build (sub-floor latency probes) | 2.3 / 3.2 / 3.2 ms (n=6) |
| pre-sim RTT (probes) | 52.3 / 76.2 / 76.2 ms (n=6) |
| final-sim RTT (probes) | 60.8 / 794.1 / 794.1 ms (n=6) |
| best expected net per tick, either direction (lamports) | -137057 / -19908 / 10585  (n=1439) |

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 1; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | our sim | after their slot: our best |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 468424073 | 4XBqVi | buyDlmmSellPump | 0.171634 | 0.000965 | 468424069 (4) | -0.000010 | no | – | – | – | -0.000023 |

Competitor txs scanned (signatures of the DLMM pools): 994.

## Opportunities we found that no competitor took

0 floor-clearing opportunity ticks; 0 had no competitor arb on the same route + direction within 25 slots after.

Measured here: everything in the tables. Not measured: landing (nothing is ever sent), gRPC/shred detection (not available in this sandbox).
Detection in this sandbox = public-RPC polling: getSlot + one getMultipleAccountsInfo per tick, every POLL_INTERVAL_MS. A competitor that back-runs a pool move in the same slot is invisible to a poller whose snapshots are several slots apart; the 'slots between consecutive snapshots' row bounds how often we can even observe pre-trade state.
