# PumpSwap venue (MAX/SOL) — notes

Program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (pump_amm; programdata `6naEzK…`, deploy slot
458,921,517, upgrade authority `7gZufw…` at the time of writing). Fee program `pfeeUxB6…` (pump-fees).
IDL: `@pump-fun/pump-swap-sdk@2.2.0` `src/idl/pump_amm.json` (npm, published 2026-10-19; not a runtime
dependency, trimmed copy in `fixtures/pumpswap/pump_amm-idl-2.2.0.trimmed.json`). The math is ported
from that SDK (`sdk/fees.ts`, `buy.ts exactQuoteInFees`, `sell.ts sellAmounts`, `multiHop.ts
poolHopAmountOut`) and was checked against on-chain events and simulation, see below.

Files: `index.ts` (class `PumpSwapPool implements SwapVenue`), `math.ts` (bigint fee + curve math),
`layout.ts` (Pool / GlobalConfig / FeeConfig decoders), `events.ts` (Buy/SellEvent), `pda.ts`,
`validate.ts` (live simulation check). Tests `test/pumpswap.test.ts`, fixtures `fixtures/pumpswap/`.

## MAX token

`5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump`: Token-2022, 409-byte mint, 6 decimals, no mint and no
freeze authority, extensions **[18 MetadataPointer, 19 TokenMetadata] only** — no TransferFeeConfig, no
TransferHook (decoded TLV; pool vault deltas equal swap amounts in every simulation). Supply
997,470,818,675,979 (some burnt). Pump.fun bonding curve `6VbDBD…` is `complete = 1` (migrated).

## Pools found (slot ≈ 468.41–468.42M; 1 MAX ≈ 3.2e-5 SOL, MAX price moved ±4% during the session)

Found by `getProgramAccounts` + memcmp of the MAX mint at each program's mint offsets (PumpSwap
base_mint @43 / quote_mint @75; DLMM token_x @88 / token_y @120; Raydium CPMM @168/@200, CLMM @73/@105,
AMM v4 @400/@432; Meteora DAMM v2 @168/@200, DAMM v1 @40/@72; Orca Whirlpool @101/@181).
"sigs/h" = signatures referencing the pool (from a 1000-signature window) — most are bots that read the
pool and do not trade; "swaps/h" is a rough estimate from a sample of successful txs.

| venue | pool | X / base | reserves | ≈TVL (SOL) | fees | sigs/h | notes |
|---|---|---|---|---|---|---|---|
| **PumpSwap** | **`Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ`** | MAX base, wSOL quote | 39.1–40.1M MAX, 1225–1257 SOL (+13–17.6 SOL virtual) | **~2,500** | 0.75% (lp 20 + protocol 5 + creator 50 bps, mcap tier) | ~257k (≈2k swaps/h est.) | canonical pump pool (index 0), the only PumpSwap pool with MAX as base |
| **DLMM** | **`5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ`** | MAX = X | 9.6M MAX + 930 SOL | **~1,235** | bin 80, base 1.0%, observed 2.08% (var.), InputOnly | ~12–44k (≈1.8k swaps/h est.) | deepest DLMM; validated |
| DLMM | `6PkALvWhf2PJ3VwPsezFJdmvQ684REGkr7vLBihkNkH` | MAX = X | 3.2M MAX + 219 SOL | ~320 | bin 200, base 1.0%, InputOnly | ~6k | |
| DLMM | `7xg8P4oQEbUuEfQMTzcNgQRvYWPdze7Fsjbvp9BtHxCz` | MAX = X | 1.2M MAX + 238 SOL | ~275 | bin 100, base 3.0%, InputOnly | ~7k | |
| DLMM | `5w4mLfdN6WxSA8GchpN5o2VtpLS8Dy7Y9oSoLopLw9LL` | MAX = X | 301k MAX + 11.9 SOL | ~21 | bin 80, base 0.8% | ~4k | |
| DLMM | `4YcoeUXitkvqxGve6c1ePwQRUFKAKpF2irBAKySGVZ9U` | MAX = X | 43k MAX + 4.9 SOL | ~6 | bin 75, base 0.75%, OnlyY | ~3k | |
| DLMM | `Gt5wsVd26Q8cJwogrmo7rUApdiLw5xB6CDcTu2cbFeGC` | MAX = X | 96k MAX + 2.7 SOL | ~6 | bin 160, base 0.8%, OnlyY (observed 5.1%) | ~3k | research wallet trades it; validated |
| DLMM | `H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ` | MAX = X | 48k MAX + 2.6 SOL | ~4 | bin 250, **base 10%** (event fee rate 0.1), OnlyY | ~300 | research wallet trades it |
| DLMM | `4pzLRE…`, `6Ng94s…`, `C7XvM7…`, `BfohY4…` | MAX = X | ≈0 | ≈0 | | ≈0 | dead |
| DLMM | `BgHgVv…` (USDC), `2TEkHs…` (USDT) | | | | | | not SOL-quoted |
| Raydium CLMM | `B2TQ1b…`, `EF4MDr…`, `4ozpY4…`, `4daoPB…`, `AYEn6a…`, `9z2fAa…`, `4eTWXb…` | wSOL = 0, MAX = 1 | largest: 2.8 SOL + 173k MAX | ≤ 8 | | | small |
| Raydium CPMM | `9JNxjc…` | | dust | 0 | | | |
| Meteora DAMM v2 | `53QQ1a…`, `fVXfYw…`, `HiY3sB…`, `4vXU8v…`, `2FTYjV…` (+ USDC `85WuiK…`, other `5Pescx…`) | MAX = A | largest: 31k MAX + 1.3 SOL | ≤ 2.3 | | | small |
| Orca Whirlpool | `J9H1Yv…` | other token / MAX | | | | | not SOL-quoted |
| Raydium AMM v4, DAMM v1 | – | | | | | | none |
| PumpSwap, MAX as quote | `6ouoeg…`, `CBahb8…` | other token base | | | | | not MAX/SOL |

**Primary pair: PumpSwap `Eoe22Hd…` (MAX base / wSOL quote) ⇄ DLMM `5nwdWt…` (MAX = X, wSOL = Y).**
Token order confirmed from the decoded accounts on both. Note the fee asymmetry: PumpSwap 0.75% vs
DLMM ≥1% base plus the variable fee (2.08% observed on 5nwdWt): a round trip costs ≈ 2.8–3.5%.
The research wallet's two successful MAX arbs in the sample used the *small* DLMM pools `Gt5ws…`
(sell 2.9k MAX, fee 5.12%) and `H6Bcg…` (fee 10%), not `5nwdWt`; any of the DLMM pools can be
constructed with `DlmmSwapVenue({ pool, tokenMint })`.

## Instruction choice

The IDL has `buy(base_amount_out, max_quote_amount_in, track_volume)` (exact-out), `buy_exact_quote_in
(spendable_quote_in, min_base_amount_out, track_volume)` (exact-in, v1), `sell(base_amount_in,
min_quote_amount_out)`, and the **v2** variants `buy_v2`, `buy_exact_quote_in_v2(spendable_quote_in,
min_base_amount_out)`, `sell_v2(base_amount_in, min_quote_amount_out)`.

We use **`buy_exact_quote_in_v2`** (disc `c2ab1c46684d5b2f`) and **`sell_v2`** (disc `5df6823ce7e940b2`):
exact-in with an on-chain min-out (deterministic: given the state, the debit and output are exactly
quoted), and they need 17 fixed accounts (no protocol-fee recipient, no coin-creator vault, no global
volume accumulator, no fee program, no remaining accounts) — that is also what the research wallet's
program CPIs (`BuyExactQuoteInV2` / `SellV2` in its logs). v2 is refused for cashback coins
(`supportsTradeV2 = !is_cashback_coin`); MAX is not one. `min_base_amount_out` must be nonzero.

### Accounts (identical for buy_exact_quote_in_v2 and sell_v2; verified against the research txs)

| # | account | flags | MAX pool value |
|---|---|---|---|
| 0 | pool | W | `Eoe22Hd…` |
| 1 | user | W S | |
| 2 | global_config | r | `ADyA8hde…` (PDA `["global_config"]`) |
| 3 | base_mint | r | MAX |
| 4 | quote_mint | r | wSOL |
| 5 | user_base_token_account | W | user's MAX ATA (Token-2022 ATA) |
| 6 | user_quote_token_account | W | user's wSOL ATA (Token ATA) |
| 7 | pool_base_token_account | W | `BBoPKc…` |
| 8 | pool_quote_token_account | W | `AUp7uV…` |
| 9 | base_token_program | r | owner of the base mint account (Token-2022 for MAX) |
| 10 | quote_token_program | r | owner of the quote mint account (Token) |
| 11 | system_program | r | |
| 12 | user_volume_accumulator | W | PDA `["user_volume_accumulator", user]` |
| 13 | fee_config | r | `5PHirr8j…` (pump-fees PDA `["fee_config", pump_amm]`) |
| 14 | buyback_fee_recipient | W | quote ATA of one of `GlobalConfig.buyback_fee_recipients` (must exist; any listed one) |
| 15 | event_authority | r | `GS4CU59F…` |
| 16 | program | r | pump_amm |

Token programs are taken from the mint accounts' owners (both mints are in `accounts()`), not assumed.
The venue picks the first listed buyback recipient whose quote ATA exists (`HjQjng…` at the time); the
research wallet used another one (`CA7v8g…`, ATA of recipient #5) — both valid. This account is
writable in every v2 trade (write-lock contention with other traders using the same recipient).

User volume accumulator: `buy_exact_quote_in_v2` **creates it** if missing (verified in simulation for
`24Q5e2…`, which had none: +137-byte account, rent ≈ 1.84M lamports paid in SOL by the user, CU 150k vs
110k for two buys). `sell_v2` worked for users that have one; a sell by a user without one is not verified.

## Fee model (evidence: 3 historical events + every simulation)

* Fee schedule (`computeFees`): FeeConfig (pump-fees) present → canonical pump pool (pool.creator ==
  pump `["pool-authority", mint]` PDA `ZzTjeE…`) quoted in a SOL-like mint → **`fee_tiers` by market
  cap**; non-pump pools → `flat_fees`; USDC quote → `stable_fee_tiers`; other quotes → `exotic_flat_fees`
  (or flat if zero). Per-pool `creator_fee_bps` replaces the creator rate if `creator_fee_configurable`
  (MAX: 0, not used). No coin creator → creator fee 0.
* market cap = floor((quote_vault + virtual_quote_reserves) · base_mint.supply / base_vault), from the
  **pre-trade** reserves (mayhem pools: fixed supply 1e15). Current MAX tiers: lp 20, protocol 5,
  creator 50 bps for mcap ∈ [29.47k, 34.38k) SOL; 45 above, 55 below (seen in events at mcap 34.48k
  and 29.15k SOL: 45 and 55 bps). MAX sits near tier boundaries: **the creator fee steps by 5 bps when the
  mcap crosses a boundary**, which a single trade can do (quote uses the pre-trade state, as the program).
* GlobalConfig: lp 20, protocol 5, coin creator 5 bps (fallback only), **buyback_basis_points 5000**,
  8 buyback recipients, creator_fee_configurable, cashback/mayhem/boost enabled flags.

### buy_exact_quote_in_v2(s = spendable_quote_in)

```
T   = lp + protocol + creator bps
net = floor(s * 10000 / (10000 + T))
lp_fee, protocol_fee, creator_fee = ceil(net * bps / 10000)      (computed on this net)
if net + fees > s: net -= (net + fees - s)                        (fees unchanged)
base_out = floor(B * (net - 1) / (Q + net - 1))     B = base vault, Q = quote vault + virtual_quote_reserves
debit (user wSOL decrease) = net + fees   (= s, or s - 1 when net + fees < s — e.g. s = 1,001,456)
buyback_fee = floor(protocol_fee * 5000 / 10000)  -> paid out to the buyback ATA
quote vault += debit - buyback_fee;  protocol_fees += protocol_fee - buyback_fee;  creator_fees += creator_fee
virtual_quote_reserves -= (protocol_fee - buyback_fee) + creator_fee
```

### sell_v2(b = base_amount_in)

```
gross = floor(Q * b / (B + b))                                    (Q incl. virtual, as above)
fees  = ceil(gross * bps / 10000) each
require quote_vault - protocol_fees - creator_fees >= gross - lp_fee
user receives gross - lp - protocol - creator
quote vault -= user_out + buyback_fee; buckets and virtual as for buy
```

`virtual_quote_reserves + protocol_fees + creator_fees` is constant (17,585,296,592 on this pool all
session): fees parked in the vault by v2 trades are not liquidity — virtual is reduced by the same
amount, so the curve's effective quote reserve moves only by net+lp (buy) / gross−lp (sell), like v1.
`applyQuote()` implements this (verified on simulated post-state, see same-pool cases).

Notes for the engine: `out` is **not monotone at 1-lamport granularity** in the buy budget (the shave
can cost the net 2–3 units; ~0.1% of budgets), but is monotone over ≥ 4 lamports. Sell `netIn` =
amountIn; buy `netIn` = debit (amountIn or amountIn − 1). min-out can be set to the quoted out.

## Validation (`NODE_USE_ENV_PROXY=1 npx tsx src/pumpswap/validate.ts`, log `fixtures/pumpswap/validate-output.txt`)

Users: buys = research wallet `8pY1Au…` (≈410 SOL wSOL), sells = `BM9Ccy…` (≈3.7M MAX). Each case
simulates the real v2 ix with minOut = quote.out. The pool trades ~1/s, so the simulation often runs on
a newer state than the snapshot: every case is re-quoted from the pre-trade state the program reports
in its event (vaults, virtual reserves, supply) and must match to the base unit; "stable" = the event
state equals our snapshot (then the snapshot quote is also checked). Also checked: every event fee field,
buyback fee and fee bps, and both pool vault deltas.

Results (all runs, ~110 single cases, at the 50 bps creator tier and — after MAX's mcap rose past 34.38k SOL — at the 45 bps tier): **every scored case matched exactly** (user balance deltas, event fields,
vault deltas). Example run (slot 468.418M, fees 20/5/50):

| side | amount in | stable | q netIn | sim netIn | q out | sim out |
|---|---|---|---|---|---|---|
| buy | 1,000,000 (0.001 SOL) | – | 1000000 | 1000000 | 32052416 | 32052416 |
| buy | 1,001,456 (shave case) | ✓ | **1001455** | **1001455** | 32035902 | 32035902 |
| buy | 10,000,000 | ✓ | 10000000 | 10000000 | 319417872 | 319417872 |
| buy | 50,000,000 | ✓ | 50000000 | 50000000 | 1595547087 | 1595547087 |
| buy | 100,000,000 | – | 100000000 | 100000000 | 3191801230 | 3191801230 |
| buy | 100,000,421 (shave) | – | 100000420 | 100000420 | 3246812288 | 3246812288 |
| buy | 500,012,345 | ✓ | 500012345 | 500012345 | 16229171400 | 16229171400 |
| buy | 1,000,000,007 | – | 1000000007 | 1000000007 | 32690414537 | 32690414537 |
| buy | 5,000,000,001 | ✓ | 5000000001 | 5000000001 | 162926171899 | 162926171899 |
| buy | 25,000,000,999 | ✓ | 25000000999 | 25000000999 | 801042609893 | 801042609893 |
| buy | 1,000 lamports | ✓ | 1000 | 1000 | 32703 | 32703 |
| sell | 32,933,638 (≈0.001 SOL) | ✓ | 32933638 | = | 992536 | 992536 |
| sell | 329,335,281 (≈0.01) | ✓ | | = | 9925288 | 9925288 |
| sell | 1,646,675,915 (≈0.05) | – | | = | 49629630 | 49629630 |
| sell | 3,293,351,707 (≈0.1) | – | | = | 99357058 | 99357058 |
| sell | 16,466,758,046 (≈0.5) | ✓ | | = | 496705514 | 496705514 |
| sell | 32,933,515,969 (≈1) | – | | = | 991256625 | 991256625 |
| sell | 164,667,579,357 (≈5) | ✓ | | = | 4939195692 | 4939195692 |
| sell | 823,337,896,294 (≈25) | – | | = | 24318729420 | 24318729420 |
| sell | 3,293,351,584,808 (≈100) | ✓ | | = | 91753816964 | 91753816964 |
| sell | 1 base unit | | quote = null (0 out; the program would reject) | | | |

Same pool, two trades in one tx (2nd quoted after `applyQuote`): buy+buy and buy+sell at 0.1 and 2 SOL
— final balances, the 2nd event's pre-state, post vaults, post buckets and post virtual reserves all
equal the model.

Round trips: see "Per-pool validation" below (24 one-tx round trips over three DLMM pools).

## Per-pool validation: DLMM 5nwdWt / 6PkALv / H6Bcgd with PumpSwap Eoe22Hd (slot ≈ 468.42–468.43M)

On-chain checks (`validate-max.ts` prints them first and refuses to continue if any fails): lb_pair owned
by the DLMM program, token_x = MAX (mint owner Token-2022), token_y = wSOL (owner Token), status 0
(enabled), activation_type 0 / activation_point 0 (active), pair_type 3, both mints without transfer
fee / hook. Liquidity = sum of bins around the active bin from the cached bin arrays.

| pool | bin step / base fee | fee mode | other fee params | liquidity ±5 bins | ±20 bins | total cached (out side) | sigs/h (ok) | single swaps exact | round trips exact |
|---|---|---|---|---|---|---|---|---|---|
| `5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ` | 80 / 1.00% (bf 12500) | InputOnly, LimitOrder pair (fn 2), **has limit orders** | vfc 7500, maxVA 150000 (cap → 2.08% total seen), filter/decay 300/1200 s, reduction 5000, protocol 10% | 405k MAX + 20.2 SOL | 1.45M MAX + 80.8 SOL | 997 SOL / 5.88M MAX | ~14–55k (97%) | **20/20** (0.001–150 SOL buys, ≈0.001–100 SOL sells, up to 57 bins; 4 cases through limit orders) | **8/8** |
| `6PkALvWhf2PJ3VwPsezFJdmvQ684REGkr7vLBihkNkH` | 200 / 1.00% (bf 5000) | InputOnly, fn 2 (no live orders) | same | 102k MAX + 4.3 SOL | 287k MAX + 17.5 SOL | 182 SOL / 894k MAX | ~5–15k (84–97%) | **16/16** (0.001–20 SOL buys up to 28 bins, sells ≈0.001–20 SOL) | **8/8** |
| `H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ` | 250 / **10.0%** (bf 40000) | **OnlyY** (fee in wSOL: sells pay it from the output, rebate added to `out`) | same | 1.6k MAX + 0.09 SOL | 5.5k MAX + 0.88 SOL | 2.4 SOL / 9.2k MAX | ~300 (52–56%) | **11/11** (buys to 0.5 SOL / 38 bins, sells ≈0.001–1 SOL); 1/5/20 SOL buys and 5/20 SOL sells → quote null (exceeds the pool) | **7/7** (1 SOL DLMM buy: quote null) |
| (`Gt5wsVd26Q8cJwogrmo7rUApdiLw5xB6CDcTu2cbFeGC`) | 160 / 0.80% | OnlyY, fn 1 | | | | 2.7 SOL / 96k MAX | ~3k | 13/13 | – |

Sizes: buys 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 20 SOL (+60 and 150 SOL on 5nwdWt to reach the ask
orders), sells of MAX worth ≈0.001 … 20 SOL (+2.6M and 3.0M MAX on 5nwdWt to reach the bid order).
"Exact" = user netIn, user out, and the Swap event's amount_in, amount_out, fee, protocol_fee, host_fee
all equal to the base unit, at the Clock the simulation ran at. Logs: `fixtures/meteora/validate-max-<pool>-output.txt`.

Round trips (ONE tx each, research wallet `8pY1Au…`, `fixtures/pumpswap/validate-roundtrip-output.txt`):
leg A = buy with `solIn` on venue A (min-out = quote), leg B = sell exactly leg A's quoted MAX on venue B.
Δ = final balance change; quote = sim in every row.

| DLMM pool | direction | 0.01 SOL | 0.1 SOL | 0.5 SOL | 1 SOL |
|---|---|---|---|---|---|
| 5nwdWt | pump buy → DLMM sell: ΔwSOL / ΔMAX | −475,947 / +111,191 | −4,607,789 / +1,013,420 | −23,171,681 / +15,418,861 | −45,864,634 / +10,136,473 |
| 5nwdWt | DLMM buy → pump sell: ΔwSOL / ΔMAX | −372,980 / 0 | −3,916,468 / 0 | −19,550,322 / 0 | −42,236,951 / 0 |
| 6PkALv | pump → DLMM | −658,703 / +299,366 | −7,205,494 / +4,829,840 | −27,913,704 / +15,629,296 | −59,733,012 / +29,008,288 |
| 6PkALv | DLMM → pump | −1,014,088 / 0 | −10,529,526 / 0 | −52,646,662 / 0 | −114,943,743 / 0 |
| H6Bcgd | pump → DLMM | −1,176,904 / 0 | −19,054,860 / 0 | −163,946,600 / 0 | −395,524,583 / 0 |
| H6Bcgd | DLMM → pump | −1,029,266 / 0 | −17,114,181 / 0 | −203,130,546 / 0 | quote null (pool too small) |

ΔMAX > 0 on InputOnly pools = the DLMM host rebate (paid in MAX) plus, when PumpSwap moved between
snapshot and simulation, the difference between the real and the quoted leg-A output (leg B sells a fixed
amount); the re-quote from the PumpSwap event reproduces it exactly. No arbitrage existed at these
moments, hence the losses. Round-trip cost ≈ 0.75% (pump) + 2.1% (5nwdWt, VA capped) / 2–3% (6PkALv) /
≥10% (H6Bcgd).

### Selecting pools by config (`src/pumpswap/pools.ts`)

`MAX_PUMPSWAP_POOL` (default `Eoe22Hd…`), `MAX_DLMM_POOLS=5nwdWt,6PkALv,H6Bcgd` (aliases = first 6
characters, or full addresses; default all three, deepest first; `MAX_DLMM_POOL` = single-pool
shorthand). `selectedMaxDlmmPools()`, `createSelectedMaxVenues()` return addresses / venues;
`MAX_DLMM_POOLS` registry carries fee mode, bin step and base fee. The engine's `src/engine/pair-venues.ts`
still hard-codes H6Bcgd — wiring it to `createSelectedMaxVenues()` is the lead's/engine owner's call.
`validate.ts --dlmm <list>` and `validate-max.ts --pool <addr>` take the same pools.

## Latency (offline, cached snapshot)

`quoteExactIn` ≈ **0.4–0.5 µs** (buy and sell); `update()` 1–2 µs (raw-bytes compare, decode only what
changed); ix build ≈ 5 µs with the user's ATAs cached (PDA derivation ≈ 0.1–0.5 ms the first time).

## Not verified / caveats

* Mayhem-mode pools (fixed supply in mcap, reserved fee recipients, no buyback), cashback coins (v2 is
  refused → quote null), holder-reward pools (refused, never observed), non-pump pools (flat fees),
  USDC/stable and exotic schedules, per-pool creator fee override: implemented from the SDK, not
  exercised on chain.
* Token-2022 transfer fees on either mint (quote returns null if the base mint has a non-zero
  TransferFeeConfig or a hook; wSOL is classic Token). Negative virtual reserves, pre-upgrade pool
  layouts (shorter accounts decode with defaults).
* Fee tiers other than the 45/50/55 bps ones seen; a FeeConfig change takes effect on the next
  `update()` (it is in `accounts()`).
* `sell_v2` for a user with no user_volume_accumulator.
* v1 instructions (`buy`, `buy_exact_quote_in`, `sell`) are not built; their pricing differs (fees
  leave the vault).
