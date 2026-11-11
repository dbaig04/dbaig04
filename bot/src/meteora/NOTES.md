# Meteora DLMM venue (RISE/SOL) — notes

Pool `4xjgBHDdLJcHYyWsL7pLCpUR556qVJyizLQ4qPVgrapt`, program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`.
token X = RISE `EMdcVn…rise` (Token-2022, 9 dp), token Y = wSOL (SPL Token, 9 dp). Price = Y per X = 1.01^activeId.

Files: `index.ts` (class `MeteoraDlmm`, implements `DlmmVenue`), `math.ts` (bigint fee + bin math),
`layout.ts` (zero-copy decoders), `pda.ts`, `rpc.ts` (throttled RPC for validate only), `validate.ts`
(live simulation check). Tests: `test/meteora.test.ts`, fixtures in `fixtures/meteora/`.

## Why not the SDK at runtime

`@meteora-ag/dlmm` 1.9.14's ESM build fails under our `"type": "module"` project
(`import { BN } from "@coral-xyz/anchor"` — no such named export). It also uses `Date.now()` as the
swap timestamp (the program uses the Clock sysvar) and BN math. The swap math was therefore ported to
bigint from the SDK sources (embedded in its source map), and decoders were written against its IDL.
The test suite loads the SDK via `createRequire` (CJS build) only to cross-check the decoders.

Two deviations from the SDK, both forced by simulation evidence:
1. **Host fee is split per bin**: `host += floor(binProtocolFee * 2000 / 10000)` for every bin, not on
   the swap total (multi-bin swaps were off by a few units otherwise).
2. **Exact-out: no `delta` added to protocolFee.** `swapExactOutQuoteAtBin` in the SDK adds
   `quotedOut - outAmount` (output-token units!) to the input-token protocol fee. The program does not;
   with it, buyRise exact-out host fees were wrong by ~20%.

## Current pool parameters (decoded at slot ~468.16M)

| field | value | meaning |
|---|---|---|
| bin_step | 100 | 1% per bin |
| base_factor / base_fee_power_factor | 10000 / 0 | base fee = 10000*100*10 = 1e7 / 1e9 = **1.00%** |
| variable_fee_control | 7500 | var fee = ceil(7500 * (VA*100)^2 / 1e11) (1e9 precision) |
| max_volatility_accumulator | 150000 | var fee cap 16,875,000 = **1.6875%** → max total **2.6875%** (MAX_FEE_RATE 10% not binding) |
| filter_period / decay_period / reduction_factor | 300 s / 1200 s / 5000 | see VA logic |
| protocol_share | 1000 | 10% of the trading fee |
| HOST_FEE_BPS (const) | 2000 | 20% of the protocol fee goes to `host_fee_in` (if passed) |
| function_type | 2 (LimitOrder) | limit-order liquidity is swappable (but see below) |
| collect_fee_mode | 0 (InputOnly) | fee is always charged on the **input** token |
| status / activation_point | 0 / 0 | enabled, active |
| pair_type | 3 | |
| bin array bitmap | indices -12..5 initialized | all inside internal bitmap → bitmap extension not needed (pass program id = None) |
| bin arrays | version 2 | pre-limit-order layout; LO fields are zero |

Fee rate observed in events (`fee_bps`, 1e9 precision) ranged 10,000,000 (VA=0) … 26,875,000 (VA capped).

### Fee model (per swap)

```
now = Clock.unix_timestamp
elapsed = now - v.last_update_timestamp
if elapsed >= filter_period:            # else keep index_reference / volatility_reference
    index_reference = active_id
    volatility_reference = elapsed < decay_period ? floor(VA * reduction_factor / 10000) : 0
for each bin with liquidity on the output side, walking from active_id in swap direction:
    VA = min(volatility_reference + |index_reference - bin_id| * 10000, max_VA)
    rate = min(base + ceil(vfc * (VA*bin_step)^2 / 1e11), 1e8)
    exact-in : fee = ceil(in * rate / 1e9); fill (in-fee) at bin price (out rounded down; if the bin
               is exhausted, in_used = ceil(max_out*2^64/price) etc., fee recomputed as
               ceil(excl*1e9/(1e9-rate)) - excl)
    exact-out: excl_in = ceil(out * price / 2^64) (X out) or ceil(out*2^64/price) (Y out);
               in = ceil(excl_in*1e9/(1e9-rate))
    protocol_fee_bin = floor(fee * protocol_share / 10000)     (no limit-order fill)
    host_fee_bin     = floor(protocol_fee_bin * 2000 / 10000)
after the swap: last_update_timestamp = now, active_id = last bin, v.VA = VA of last bin.
```

The Clock matters: the same state quoted at a timestamp on the other side of `last_update + 300` or
`last_update + 1200` gives a different fee. We fetch `SysvarC1ock…` in the same `getMultipleAccounts`
batch, so quotes are for that slot's timestamp; the tx lands ~1-2 s later, which only matters right
at those boundaries (engine: keep minOut/maxIn slippage ≥ 1 bin's fee delta, or re-quote with
`clock.unixTimestamp + 2`).

### Host-fee rebate (what the reference wallet does)

The reference wallet passes **its own input token account as `host_fee_in`**. The program then
transfers 20% of the protocol fee (= 2% of the total fee, ~0.02-0.054% of notional) from the reserve
back to the user within the same instruction. Evidence: tx `21Z1Fd…` inner transfers
`BKxadb→Gsktqp 858078326245` then `Gsktqp→BKxadb 203793602` (= Swap event `host_fee`), and reserve X
grew by exactly 857874532643. Our instructions do the same by default (`hostFeeRebate: true`):

* `quoteExactIn(...).out` — output received (exactly what the program transfers; minOut can be set to it).
* `quoteExactOut(...).inp` — gross input the program pulls (= event `amount_in`; maxIn can be set to it).
* extra field `netIn` on both results = real decrease of the user's input balance (gross − host rebate).
  **The engine should use `netIn` for profit.** Other extras: `fee`, `protocolFee`, `hostFee`,
  `endBinId`, `lastFeeRate`.

Two of the ~96 historical swaps passed `host_fee_in = program id` (None) and got `host_fee = 0`.

## Token-2022 handling

RISE mint (`EMdcVn…`, 426 bytes) extensions: `[18 MetadataPointer, 19 TokenMetadata]` only.
**No TransferFeeConfig, no TransferHook.** Evidence: pool reserve deltas equal the swap amounts exactly
in every historical tx and in simulation. The code still parses TransferFeeConfig (epoch-dependent
older/newer fee, applied to input before the swap and to output after, SDK semantics) and refuses to
quote (returns null) if a transfer hook ever appears; the transfer-fee branch is **untested** against
the chain (nothing to test it on). `RemainingAccountsInfo` is always an empty vec.

## Bin arrays

* PDA `["bin_array", lb_pair, i64 LE index]`, 70 bins each, bin id → index `floor(id/70)`.
* `update()` reads the internal bitmap (16 × u64, bit k ↔ index k−512) from lb_pair and `accounts()`
  then requests every initialized array within ±`binArrayWindow` (default 12 = 840 bins) of the
  active array — currently all 18 arrays (-12..5). Unchanged arrays are not re-decoded.
* A quote walks bins from the active bin in swap direction (down for sellRise / X→Y, up for buyRise),
  skipping empty bins, jumping over uninitialized arrays, returning `null` if it reaches an
  initialized-but-uncached array or the last initialized array (insufficient liquidity).
* `binArrays` returned = arrays traversed, in traversal order, + `extraBinArrays` (default 1) next
  initialized arrays in swap direction (headroom if the price moves before landing).
  The reference bot passes a fixed ascending window for SOL→RISE and descending for RISE→SOL, with
  arrays that don't necessarily start at the active one; the program looks arrays up by index, so
  order/extra arrays are tolerated. All bin arrays are writable.

## Instruction layout (verified against IDL + tx 21Z1Fd… / 23QRS8…)

`swap2`: disc `414b3f4ceb5b5b88`, `u64 amount_in, u64 min_amount_out, RemainingAccountsInfo{slices: vec(len 0)}`.
`swap_exact_out2`: disc `2bd7f784893cf351`, `u64 max_in_amount, u64 out_amount, RemainingAccountsInfo`.

| # | account | flags | value |
|---|---|---|---|
| 0 | lb_pair | W | 4xjgBH… |
| 1 | bin_array_bitmap_extension (optional) | r | program id = None |
| 2 | reserve_x | W | Gsktqpz1… (RISE) |
| 3 | reserve_y | W | GomTD5xe… (wSOL) |
| 4 | user_token_in | W | user ATA of input mint |
| 5 | user_token_out | W | user ATA of output mint |
| 6 | token_x_mint | r | EMdcVn…rise |
| 7 | token_y_mint | r | So111… |
| 8 | oracle | W | BazcZcc1… |
| 9 | host_fee_in (optional) | W | = user_token_in (rebate) or program id |
| 10 | user | S | |
| 11 | token_x_program | r | Token-2022 (lb_pair.token_mint_x_program_flag=1) |
| 12 | token_y_program | r | Token |
| 13 | memo_program | r | MemoSq4g… |
| 14 | event_authority | r | D1ZN9W… (PDA `__event_authority`) |
| 15 | program | r | LBUZK… |
| 16+ | bin arrays | W | |

User ATAs are derived (RISE via Token-2022 ATA, wSOL via Token ATA); for the reference wallet these are
BKxadb… and FrAqBU…. The caller must make sure the output ATA exists (validate.ts creates it
idempotently for the seller wallet). Observed CU: ~41k (1 bin) … ~434k (65 bins).

## Pool depth (slot ~468.16M, active bin -743, price ≈ 0.000615 SOL/RISE)

* SOL side (sellRise): ~211 SOL total, all in arrays -11/-12 (bins -743…-840). 57k RISE moves ~12
  bins (-743→-755) for 32.5 SOL; ~300k RISE would take it to -804 for ~134 SOL.
* RISE side (buyRise): ~839k RISE in arrays -11…5. 100 SOL moves ~35 bins, 200 SOL ~64 bins.
* Limit orders: none (bin arrays are version 2). LO math (processed → open tranches, fee split with
  LIMIT_ORDER_FEE_SHARE 50%) is ported from the SDK but is used only for version ≥ 3 arrays and is
  **unverified on-chain**.

## Validation

Run `NODE_USE_ENV_PROXY=1 npx tsx src/meteora/validate.ts [--write-fixtures]` (Node's fetch ignores
HTTPS_PROXY without that flag). Users: buyRise = reference wallet 24Q5e2… (≈208 SOL wSOL);
sellRise = 72wotPiw… (a system wallet holding ≈57.8k RISE; the reference wallet only has ~90 RISE).
Simulation uses `sigVerify:false, replaceRecentBlockhash:true`, sets minOut=quote.out (exact-in) and
maxIn=quote.inp (exact-out), reads post-balances + the Clock the sim ran at, and only scores cases where
the pool/bin arrays/user accounts were byte-identical before and after the simulation window.
A case "matches" only if netIn, out, event amount_in and event host_fee are all equal to the base unit.
Two-leg cases (buy then sell in one tx) additionally check `applySwap()`'s modelled post-state
(active id, VA/VR/index_reference/last_update_timestamp, every bin's amount_x/amount_y) against the
simulated lb_pair and bin array post-state.

Five full runs (slots 468159740 … 468166772). After the two SDK deviations above were fixed, every
scored case in every run matched (25/25 in each of the last three runs). Each fee branch was exercised
live: run 1 at elapsed 919 s (decay branch, VR = VA*0.5), runs 3-4 at elapsed 142-200 s (filter branch,
reference kept, active bin away from index_reference), run 5 at elapsed > 1200 s (reset, VR = 0).
Two-leg cases test the elapsed = 0 branch. Full log of the last run: `fixtures/meteora/validate-output.txt`.

Last run (VR reset branch; q = quote, s = simulated; netIn = decrease of input balance after host rebate):

| side | mode | amount | q netIn | s netIn | q out | s out | bins | match |
|---|---|---|---|---|---|---|---|---|
| buyRise | exactIn | 0.001 SOL | 999800 | 999800 | 1608480925 | 1608480925 | -743 | ✓ |
| buyRise | exactIn | 0.1 SOL | 99979977 | 99979977 | 160594125258 | 160594125258 | -743→-742 | ✓ |
| buyRise | exactIn | 1 SOL | 999798627 | 999798627 | 1593785376549 | 1593785376549 | -743→-742 | ✓ |
| buyRise | exactIn | 5 SOL | 4998982355 | 4998982355 | 7926716114818 | 7926716114818 | -743→-741 | ✓ |
| buyRise | exactIn | 25 SOL | 24993484066 | 24993484066 | 37948843390356 | 37948843390356 | -743→-732 | ✓ |
| buyRise | exactIn | 100 SOL | 99954290829 | 99954290829 | 132401286516369 | 132401286516369 | -743→-708 | ✓ |
| buyRise | exactIn | 200 SOL | 199900540842 | 199900540842 | 228797258693809 | 228797258693809 | -743→-679 | ✓ |
| buyRise | exactOut | 10.12 RISE | 6292542 | 6292542 | 10123456789 | = | -743 | ✓ |
| buyRise | exactOut | 1000.1 RISE | 627072331 | 627072331 | 1000123456789 | = | -743→-742 | ✓ |
| buyRise | exactOut | 10k RISE | 6323927720 | 6323927720 | 10000123456789 | = | -743→-740 | ✓ |
| buyRise | exactOut | 100k RISE | 71747233622 | 71747233622 | 100000123456789 | = | -743→-717 | ✓ |
| buyRise | exactOut | 150k RISE | 115590177662 | 115590177662 | 150000123456789 | = | -743→-703 | ✓ |
| sellRise | exactIn | 1.99 RISE | 1987256791 | 1987256791 | 1211142 | 1211142 | -743 | ✓ |
| sellRise | exactIn | 101 RISE | 100967456791 | 100967456791 | 61535078 | 61535078 | -743 | ✓ |
| sellRise | exactIn | 1001 RISE | 1000787456791 | 1000787456791 | 609934494 | 609934494 | -743 | ✓ |
| sellRise | exactIn | 10k RISE | 9998960584023 | 9998960584023 | 6026389353 | 6026389353 | -743→-745 | ✓ |
| sellRise | exactIn | 30k RISE | 29994267599573 | 29994267599573 | 17648006907 | 17648006907 | -743→-750 | ✓ |
| sellRise | exactIn | 57k RISE | 56984772840441 | 56984772840441 | 32445639034 | 32445639034 | -743→-756 | ✓ |
| sellRise | exactOut | 0.001 SOL | 1647901323 | 1647901323 | 1004321 | = | -743 | ✓ |
| sellRise | exactOut | 0.1 SOL | 164088227518 | 164088227518 | 100004321 | = | -743 | ✓ |
| sellRise | exactOut | 1 SOL | 1640818465647 | 1640818465647 | 1000004321 | = | -743 | ✓ |
| sellRise | exactOut | 10 SOL | 16727492367645 | 16727492367645 | 10000004321 | = | -743→-747 | ✓ |
| sellRise | exactOut | 30 SOL | 52394520134313 | 52394520134313 | 30000004321 | = | -743→-755 | ✓ |
| two-leg | buy 5 SOL, sell ½ | | ΔRISE 3981980135080 | = | ΔwSOL -2537803623 | = | A→-741, B→-742 | ✓ (+ post-state) |
| two-leg | buy 40 SOL, sell all | | ΔRISE 19173805730 | = | ΔwSOL -1231250501 | = | A→-728, B→-743 | ✓ (+ post-state) |

The event amount_in, fee, protocol_fee and host_fee also matched in every case. CU ranged 41k … 434k.

Historical replay (offline test): all 63 single-bin historical swaps of the reference wallet
(`fixtures/meteora/historical-single-bin.json`, swap2 and swap_exact_out2, both directions) reproduce the
Swap event's amount_in, amount_out, fee, protocol_fee and host_fee exactly from the bin price and the
event's fee rate.

Latency (offline, fixture state): 2-5 µs for 1-bin quotes, ~15-35 µs for 20-65-bin quotes, exact-in
and exact-out alike; `update()` ~120 µs (bin arrays cached by raw bytes).

## Not verified / caveats

* Limit-order liquidity and Token-2022 transfer fees (not present on this pool).
* Bitmap extension (not needed: min/max bin ±3516 → array indices ±51 ⊂ internal ±512 range).
* Engine must model the RISE ATA / wSOL ATA existence and wrapping itself.
