# MAX shadow run (PumpSwap ⇄ Meteora DLMM)

Final — started 2026-11-12T06:23:58.764Z, 36.0 min, 1439 ticks. **All numbers are MEASURED on public-RPC polling in simulate mode** (no gRPC / shreds in this sandbox); nothing was sent.

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

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 3; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | our sim | after their slot: our best |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 468423969 | 8L2y55 | buyPumpSellDlmm | 0.048473 | 0.000020 | 468423966 (3) | -0.000027 | no | – | – | – | -0.000021 |
| 468424072 | 55rBmc | buyDlmmSellPump | 0.235037 | 0.000033 | 468424069 (3) | -0.000017 | no | – | – | – | -0.000006 |
| 468424209 | 8pY1Au | buyDlmmSellPump | 0.007952 | -0.000011 | 468424204 (5) | -0.000019 | no | – | – | – | -0.000030 |

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

Floor-clearing opportunities: 0 ticks; passing final simulations: 0. Competitor arbs on this route during the run: 10; seen by us on pre-trade state: 0; executable (our sim cleared the floor on pre-trade state): 0.

| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | our sim | after their slot: our best |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 468424073 | 4XBqVi | buyDlmmSellPump | 0.171634 | 0.000965 | 468424069 (4) | -0.000010 | no | – | – | – | -0.000023 |
| 468424209 | 1UVuP6 | buyDlmmSellPump | 0.172070 | 0.000592 | 468424204 (5) | -0.000013 | no | – | – | – | -0.000024 |
| 468424282 | AJhFgS | buyDlmmSellPump | 0.171720 | -0.000005 | 468424277 (5) | -0.000012 | no | – | – | – | -0.000027 |
| 468425684 | GxDC9e | buyDlmmSellPump | 0.000027 | -0.000053 | 468425679 (5) | -0.000040 | no | – | – | – | -0.000033 |
| 468425684 | GxDC9e | buyDlmmSellPump | 0.026641 | 0.000692 | 468425679 (5) | -0.000040 | no | – | – | – | -0.000033 |
| 468425990 | 8L2y55 | buyDlmmSellPump | 0.013307 | 0.000009 | 468425987 (3) | 0.000011 | no | – | – | – | -0.000028 |
| 468426043 | 3U2tSm | buyDlmmSellPump | 0.011378 | 0.000016 | 468426035 (8) | -0.000015 | no | – | – | – | -0.000001 |
| 468426046 | GLiCiN | buyDlmmSellPump | 0.001933 | 0.000004 | 468426043 (3) | -0.000001 | no | – | – | – | -0.000021 |
| 468426070 | 8L2y55 | buyDlmmSellPump | 0.013307 | 0.000005 | 468426064 (6) | -0.000012 | no | – | – | – | -0.000028 |
| 468428749 | 2QfBNK | buyDlmmSellPump | 0.000003 | -0.000005 | 468428743 (6) | – | no | – | – | – | – |

Competitor txs scanned (signatures of the DLMM pools): 1971.

## Opportunities we found that no competitor took

0 floor-clearing opportunity ticks; 0 had no competitor arb on the same route + direction within 25 slots after.

## Competitor coverage (MEASURED; read the comparison tables with this in mind)

Competitor arbs come from `getSignaturesForAddress` + `getTransaction` (v1) on the three DLMM pools. The run's slots
were 468,423,561–468,433,591.
- **H6Bcgd: full window.** All 326 pool txs were fetched afterwards; complete for this route.
- **6PkALv and 5nwdWt: first ~460 slots only** (468,423,629–468,424,089, about 2 min). 5nwdWt sees about 15 txs/s,
  mostly no-swap txs from many bots. The in-run watcher's fetch budget (0.6 req/s, public RPC, heavy 429s) fell behind
  after that. A post-run backfill of 6PkALv reached only slots after the run ended, so it adds nothing.
- **Consequence.** Executability for 6PkALv and 5nwdWt is judged on a 2-minute sample. Missing competitor arbs there
  are a coverage gap, not evidence of absence.

## Executability summary (MEASURED)

- **No floor-clearing opportunity on any route.** Across 1,439 ticks, no snapshot gave a plan with expected net
  ≥ 100,000 lamports after fees.
  - Best expected net per route: max:5nwdWt −5,882; max:6PkALv −5,297; max:H6Bcgd +10,585, all below the floor.
  - So no "real" build or simulation happened. Build and simulation latencies come from sub-floor latency probes:
    same build path, same simulateTransaction call, the floor check expected to fail.
- **Every competitor arb landed between two of our snapshots.**
  - Our last pre-trade snapshot was 3–8 slots before each competitor's landing slot.
  - At that snapshot our best expected net in the competitor's direction was negative, with one exception: +11,000
    lamports before 8L2y55's arb, which netted them +9,064. In every case the opportunity was below our floor or did
    not exist yet in our view.
  - After their slot it was gone again.
  - These are back-runs of a pool move that appeared and was consumed within the 7–8-slot gap between our polls.
  - We "saw" none of them, so none was executable for us.
- **Competitor profit is mostly small.** On H6Bcgd, 3 of 10 arbs netted > 100,000 lamports: 964,577, 691,849 and
  591,895. The rest were between −52,744 and +16,121.

## Run #1 (H6Bcgd only, 21 min, 833 ticks; superseded by this 3-route run)

- No opportunities, and 0 competitor arbs among the 15 DLMM-pool txs its watcher fetched. That watcher had the same
  coverage problem.
- Latencies were in line with this run:
  - state poll 124 / 224 ms;
  - quote 0.13 / 0.25 ms;
  - probe build 2.3 / 4.4 ms;
  - pre-sim 53 / 93 ms;
  - final sim 53 / 85 ms (median / p95).

## What changes with gRPC (ESTIMATED, not measured here)

- **Detection.** With ERPC Geyser gRPC (and Shreds UDP), detection becomes event-driven per account update. The repo's
  earlier VPS measurement in README/BENCH reports update→decision of a few ms. That removes the ~150 ms poll RTT and
  the 7–8-slot sampling gap, which is what made every competitor arb invisible here.
- **Quote and build stay the same:** about 0.1–0.2 ms per route and about 2–4 ms respectively.
- **Simulation** stays one RPC round trip. Co-located, it should be well below the public-RPC 50–60 ms median measured
  here, but that is not measured.
- **Unknown in every setup:** whether we would land before competitors that back-run in the same slot. Nothing was
  sent, so landing is unmeasured.

