# Decision-path benchmark

Target: under 50 ms from receiving an account update to a signed (or ready) transaction.
This file separates **measured** numbers from **estimated** ones.

Reproduce:

```bash
NODE_USE_ENV_PROXY=1 npx tsx src/engine/bench.ts record --n 50          # re-record fixtures/bench/snapshots.json.gz
npx tsx src/engine/bench.ts offline --iters 500 --baseline               # offline replay, per stage
NODE_USE_ENV_PROXY=1 npx tsx src/engine/bench.ts live --seconds 75       # main.ts, simulate mode, RPC polling
NODE_USE_ENV_PROXY=1 npx tsx src/engine/bench.ts live --seconds 60 --force-build   # + build and simulate every tick
```

Environment: 4-core sandbox, Node 22, public RPC `api.mainnet-beta.solana.com` reached through an HTTPS proxy. Live
runs stay at 2.5 req/s or less. The live runs never send: the mode is simulate and there is no keypair.

Fixture: `fixtures/bench/snapshots.json.gz` (43 KiB). It holds 50 real mainnet snapshots, recorded one every 2.5 s
over slots 468,173,557–468,174,122. Each snapshot covers all 26 accounts the venues and the reference wallet's ATAs
use, and the data is deduplicated by content. During the recording the RISE market changed 3 times and the DLMM pool
did not change. Program: `fixtures/rise/program.so.gz`, the current deploy at slot 468,145,973.

## Before vs after (measured)

All "after" numbers use max input 0.1 SOL, a 100,000-lamport net floor, and fees from `fees.ts`.

| stage | before: median / p95 | after: median / p95 |
|---|---|---|
| live, update → decision (simulate mode, RPC polling) | **1663 / 1743 ms** (p50/p90; the task's measurement, includes the RPC fetch) | **0.6 / 1.4 ms** from data arrival (75 s run, 74 ticks) |
| offline, optimize both directions (cold) | **1366 / 1555 ms** (HEAD code on these snapshots, 40 iters) | **0.93 / 1.76 ms** (skip path), **1.31 / 6.04 ms** (with opportunities) |
| offline, RISE fast-grid warm-up | not separate (each exact quote 3.5 ms; ~780 exact quotes per tick) | **8.1–8.6 / 11.3–11.9 ms**, only when RISE state changed (6 exact quotes) |
| offline, ingest (all `update()`s) | 1.4 / 363.8 ms (HEAD; the p95 includes worker respawns) | 0.19 / 1.19 ms (sequence), 0.98 / 1.87 ms (cold) |
| offline, tx build unsigned / signed | 1.4 / 1.8 ms, 2.3 / 3.5 ms (HEAD) | 0.64 / 0.97 ms, 1.22 / 1.98 ms |
| blockhash before build | 1 × `getLatestBlockhash` RTT on the hot path (≈ 55–150 ms through this proxy, **estimated** from similar calls) | 0: background cache, refreshed every 2 s |
| **update → tx built, worst case** (offline, both venues changed + arbs) | ≈ 1.4–1.6 s | **12.1 / 17.7 ms** (max 41.5 ms over 500 iters) |

### Offline replay (`bench.ts offline --iters 500 --baseline`)

| mode (500 iterations each) | ingest | warm | optimize | decision | build unsigned | build signed | **update → built** |
|---|---|---|---|---|---|---|---|
| sequence: recorded order, real change pattern | 0.19 / 1.19 | 0.00 / 8.38 | 0.88 / 1.76 | 1.10 / 10.59 | 0.60 / 0.97 | 1.21 / 2.06 | **1.77 / 11.28** |
| cold: RISE and DLMM state forced "changed" every iteration | 0.99 / 1.87 | 8.56 / 11.87 | 0.93 / 1.76 | 10.79 / 14.34 | 0.64 / 0.97 | 1.22 / 1.98 | **11.47 / 15.11** |
| perturbed: + a synthetic 2–10 SOL competitor swap on the real pool | 0.21 / 1.09 | 0.00 / 8.12 | 1.11 / 5.84 | 1.37 / 11.36 | 0.64 / 0.87 | 1.28 / 1.97 | **2.12 / 12.03** |
| cold + perturbed (worst case) | 0.98 / 1.78 | 8.09 / 11.31 | 1.31 / 6.04 | 11.43 / 16.86 | 0.67 / 1.02 | 1.26 / 1.92 | **12.13 / 17.68** |

All cells are median / p95 in ms.

Quote counts:
- **Exact RISE quotes per tick:** 0 when both directions are skipped. When an opportunity is verified, 1.0 on
  average and at most 4 per direction.
- **Grid rebuilds:** add 6 exact quotes, and only when RISE state changed.
- **Approximate evaluations:** about 350–400 per tick, each one µs-level DLMM math.
- **Perturbed modes:** 194 of 500 iterations had an opportunity, all in buyThenRedeem at the 0.1 SOL cap. Example: net
  in 99,977,600 lamports (gross 100,000,000, host rebate 22,400), gross profit 2,416,151, priority fee 50,000, net
  profit 2,361,151, min-out pad 2,404.

Quality against the old exact-only search: on 20 snapshots, half of them perturbed, both directions, with no floor so
every direction is verified, the old search found at most **1 lamport** more gross profit. It needed 781 exact quotes
and 946 / 1098 ms per snapshot. `test/engine-twostage.test.ts` checks the two-stage result against a dense exact
brute force on 5 recorded and perturbed snapshots (161-point grid plus a 41-point refinement), with a 20-lamport
tolerance.

### Live simulate-mode runs (`bench.ts live`, RPC polling, ledger `latency` rows with `kind: "tick"`)

| metric | 75 s normal run (74 ticks) | 60 s `--force-build` run (29 ticks, 2 s poll) |
|---|---|---|
| RPC refresh: getSlot + getMultipleAccounts | 144.7 / 180.8 ms | 150.6 / 650.4 ms |
| ingest | 0.3 / 1.0 ms | 0.4 / 1.1 ms |
| data received → decision | **0.6 / 1.4 ms** (max 44.1 on the first tick) | 0.8 / 2.0 ms (max 67.5 on the first tick) |
| data received → tx built | no opportunity, so no builds | **2.4 / 6.6 ms** (max 81.6 on the first tick: worker warm + grid) |
| tick start → decision (the old metric, includes the RPC poll) | 144.8 / 180.8 ms | 150.7 / 715.1 ms |
| pre-sim RTT (`simulateTransaction`) | – | **55.3 / 84.2 ms** (max 776) |
| final-sim RTT | – | not reached: every forced plan was below the floor, so the pre-sim rejected it as designed |

In the normal run, 73 of 74 ticks hit the optimizer cache: neither venue's quote-relevant state changed during the
run, and a cache hit is a sub-millisecond decision. `--force-build` (bench only, ignored outside simulate mode) builds
and simulates the best plan every tick, even below the floor, to measure build time and sim RTT on mainnet.

## What dominated, and what changed

1. **The optimizer drove ~780 exact RISE quotes per tick at ~1.7 ms each.** Every quote is a LiteSVM execution in the
   child process. Now the optimizer runs in two stages:
   - **Stage 1** uses RISE *Fast quotes on a 3-point exact grid over [MIN_TRADE, MAX_TRADE], built once per RISE state
     change. The average price is interpolated linearly in the amount, which matched the exact profit to the lamport
     on the recorded states. DLMM quotes are exact.
   - **Skip test:** if even the optimistic estimate misses the net floor (plus a 2-bps approximation margin), the
     direction is skipped with 0 exact quotes.
   - **Stage 2** runs exact quotes at the best ≤ 2 candidates, then one locally corrected re-centre, for at most 4 per
     direction.
2. **Each exact quote cost 3.3 ms, of which 1.2 ms was `Transaction.serialize()`.** The worker now patches the amount
   into a pre-serialized quote tx. A quote now costs 1.0–1.6 ms (`svm-worker.mjs`).
3. **Unchanged state.** `RiseNative.update()` fingerprints its accounts. When nothing changed it keeps the memoized
   quotes and the grid, and makes no worker round trip. `MeteoraDlmm.quoteKey()` combines a state version with the
   clock-derived volatility references and the epoch. The engine reuses the last optimizer result while both keys and
   the limits are unchanged.
4. **Hot-path RPC.** `getLatestBlockhash` was called after every decision. `blockhash.ts` now keeps a blockhash
   refreshed every 2 s, and the engine falls back to a fetch only if the cached one is older than 20 s.
5. **CU limit.** The CU limit is learned from the last final sim of each direction (units × 1.1 × headroom). With it,
   the ready tx is the final tx and the pre-sim RTT is skipped. A failed final sim forgets it.
6. **ATA derivation.** User ATAs (`findProgramAddressSync`) are cached in the RISE and DLMM ix builders.
7. **gRPC debounce.** The per-slot debounce default went from 20 to 3 ms. It still flushes earlier on the slot status.
   The ChangeSignal coalesces updates that arrive during a tick and wakes the loop immediately after it.

## Estimated, not measured

- **gRPC path.** There is no Geyser endpoint here. Update → built should equal the offline numbers plus at most the
  3 ms debounce. Stream arrival is the `received` mark.
- **Live final-sim RTT.** Assumed to equal the pre-sim RTT, since it is the same call with the same size.
- **Old `getLatestBlockhash` cost.** Not timed separately. It is the same RPC class as `simulateTransaction` and
  `getSlot` through this proxy, at about 55–150 ms.
- **A full tick with an opportunity on mainnet.** Not observed during the runs. The synthetic "perturbed" modes stand
  in for it, using real pool math through `applySwap`.
