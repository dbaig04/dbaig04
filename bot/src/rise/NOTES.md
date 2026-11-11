# RISE native venue (`src/rise/`)

Program `RiseP9yY3UnMxd1df7mgGJiR39frg9QGsr1ro3zxrDq` (Anchor, upgradeable). The market is `9akRrSgLmVgJayrdYPygwV4U3YXrAMud2fYS98QMjeRR` (mint `EMdcVn…rise`).

## How quotes are made (exact)

I could not derive a closed-form pricing formula that matches the program to the base unit. Instead, `RiseNative` **executes the real program**:

- The program binary comes from its programdata account (`2jmivXMvRcbxdsRLqBTwSLWuDgpbAoV9rFbtj5wsXB1E`, ELF at byte offset 45).
- Each `update()` loads the snapshot accounts into **LiteSVM 0.8.0**, together with the mainnet Rent sysvar.
- Each quote simulates a `Buy` or `Sell` for a **synthetic user**. That user gets 1e6 SOL of wSOL, 1e18 RISE units and pre-created ATAs, so a quote never fails for lack of funds.
- `simulateTransaction` never commits, so every quote runs against the unmodified snapshot. One quote cannot leak state into the next.
- Results are memoized per `update()`: the cache key is the direction plus the amount, and `null` results are cached too.

### Files

- `accounts.ts`: PDAs, ATA helpers (`userWsolAta`, `userRiseAta`, `userAtas`) and the ix builders.
- `market.ts`: partial decode of the market account and the fee math.
- `oracle.ts`: synchronous client for the worker. It talks over two named pipes using blocking `writeSync`/`readSync`.
- `svm-worker.mjs`: a child process (plain Node) that runs LiteSVM.
- `index.ts`: `RiseNative implements RiseVenue`.
- `validate.ts`: live comparison against mainnet.

### Why a child process, not a worker thread

litesvm 0.8.0 sometimes **aborts the whole process** with `terminate called … std::bad_alloc`. This happens on a call that comes *some time after* a simulation that failed with a program error, such as DustTrade, MinTrade or token_in > supply.

The abort is native, so it would kill every thread in the process. A worker_thread cannot contain it, which is why the SVM runs in a separate process.

Mitigations:
1. Cheap guards in the parent return `null` without simulating:
   - amount ≤ 0;
   - amount ≥ 2^64;
   - buy below `minTradeLamports` (100 000);
   - sell above supply.
2. After any failed simulation, the worker throws away its LiteSVM instance and rebuilds it (about 25 ms).
3. If the child dies anyway, the pending call respawns it and retries once (respawn plus program load takes about 0.3–0.5 s).

The crash test does 12 rounds of 2 erroring quotes followed by a valid quote. Every valid quote returned the right value. A 120-error stress run caused about 1 respawn per 10 error quotes.

**Engine implication:** avoid probing sizes the program rejects. Sells whose gross output is under 100 000 lamports (about 1.6e8 RISE units at current prices) fail with error 6401, and each such failure costs about 80 ms.

### Speed

Measured with the worker warm:

| Step | Time |
|---|---|
| Exact buy quote | ≈ 1.2–1.9 ms (was 3.5–3.9 ms) |
| Exact sell quote | ≈ 1.0–1.6 ms (was 2.3–2.9 ms) |
| Memoized repeat quote | ≈ 0 |
| `update()` (warm, state changed) | ≈ 1–3 ms |
| `update()` (no quote-relevant account changed) | ≈ 0.1 ms: memo + fast grids kept, no worker round trip |
| First `update()` | ≈ 0.3–0.5 s (spawn + program load) |

Where an exact quote's time went: `Transaction.serialize()` (message compile) ≈ 1.2 ms, the LiteSVM simulation
≈ 1.0 ms, the rest IPC/JSON. The worker now keeps one pre-serialized quote tx per kind and only patches the u64 amount
(`svm-worker.mjs` `template()`), so a quote is simulation + IPC.

`update()` fingerprints the quote-relevant accounts (bytes + lamports + owner, + program deploy slot). Quotes are a
pure function of them (the clock does not matter, see Pricing), so an unchanged fingerprint keeps every memoized
quote and both fast grids; `stateVersion` is bumped only on a real change (the engine's optimizer cache keys on it).

`quoteBuyFast` / `quoteSellFast` are approximate. Two modes:
- default: interpolate the average price over 22 exact grid points, log-spaced (buys 1e6 to 1e13 lamports, sells
  1e9 to 1e16 RISE units), ~80 ms to build lazily, ~3e-5 relative error;
- **range mode** (`fastRange` / `setFastRange`, what the engine uses): `points` (3) evenly spaced exact buys over the
  allowed trade range [MIN_TRADE, MAX_TRADE] and 3 sells over the RISE those buys produce (widened 2x each way),
  average price interpolated *linearly in the amount* (it is linear to ~1e-7 there: e.g. 1592.099372 →
  1592.081388 RISE/lamport from 1e6 to 1e8 lamports). Built by `prepareFast()` once per RISE state change, 6 exact
  quotes ≈ 8 ms; observed error vs exact on the recorded snapshots ≈ 0 (the optimizer's approximate and exact gross
  profit agreed to the lamport). Extrapolates up to 4x beyond the grid, exact beyond that.

Use the fast quotes **only for the optimizer's coarse search**. The final size must always be re-quoted with `quoteBuy` / `quoteSell`, and min-out must come from the exact quote. Outside the grid, the fast quotes fall back to the exact quote.

### Program upgrades

`accounts()` includes the programdata account. `update()` reads the deploy slot at bytes 4..12 and reloads the binary when that slot changes. The last deploy was at slot **468145973**.

The full programdata account is about **1.15 MB**, which is a lot to fetch every tick. If the engine fetches it with `dataSlice {offset:0,length:45}`, `update()` notices the slot change instead and re-fetches the binary asynchronously through the `connection` passed to the constructor. Quotes keep using the old binary until the new one loads.

### Proxy note

Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node ≥ 22.21). In this sandbox, run anything that talks to RPC with it, for example `NODE_USE_ENV_PROXY=1 npx tsx src/rise/validate.ts`.

## Live validation (`NODE_USE_ENV_PROXY=1 npx tsx src/rise/validate.ts [--save-fixture]`)

Setup:
- Fee payer and user: the reference wallet `24Q5e2…` (holding 208.2 SOL wSOL and 90.28 RISE).
- Mainnet `simulateTransaction` with `sigVerify:false` and `replaceRecentBlockhash:true`, reading the post-state of the user's wSOL and RISE ATAs.
- The snapshot was taken at slot 468161606. The market account was re-read after the last simulation and was byte-identical, so no trade landed in between.

Because the wallet holds little RISE, the `sell*` rows simulate `[Buy L, Sell T]` in one tx, where T is the RISE that Buy L mints. The local quote for those rows is `quoteSell(T)` on the post-Buy state returned by a Buy-only simulation.

| dir  | amount in | quote (exact) | mainnet simulate | match |
|------|-----------|---------------|------------------|-------|
| buy  | 1 000 000 | 1 592 099 372 | 1 592 099 372 | yes |
| buy  | 100 000 000 | 159 208 138 772 | 159 208 138 772 | yes |
| buy  | 1 000 000 000 | 1 591 917 915 322 | 1 591 917 915 322 | yes |
| buy  | 10 000 000 000 | 15 902 855 408 089 | 15 902 855 408 089 | yes |
| buy  | 50 000 000 000 | 79 154 089 967 850 | 79 154 089 967 850 | yes |
| buy  | 150 000 000 000 | 234 814 452 801 356 | 234 814 452 801 356 | yes |
| sell | 1 000 000 000 | 612 496 | 612 496 | yes |
| sell | 902 761 314 | 552 937 | 552 937 | yes |
| sell | 9 027 613 140 | 5 529 381 | 5 529 381 | yes |
| sell | 45 138 065 702 | 27 646 840 | 27 646 840 | yes |
| sell | 90 276 131 404 | 55 293 504 | 55 293 504 | yes |
| sell* | 15 902 855 408 089 | 9 751 562 499 | 9 751 562 499 | yes |
| sell* | 79 154 089 967 850 | 48 757 812 499 | 48 757 812 499 | yes |
| sell* | 234 814 452 801 356 | 146 273 437 499 | 146 273 437 499 | yes |

Result: 14/14 exact. An earlier run at slot 468161457 also gave 11/11 exact; its only failure was a sell larger than the wallet's balance, which the program rejects with token error 1.

The round trips show that the curve has **no buy/sell spread**. Buy 10 SOL then sell everything returns 9.7516 SOL, which is exactly the two 1.25% fees.

`test/rise.test.ts` re-checks the non-round-trip rows offline, from `fixtures/rise/snapshot.json` plus `program.so.gz` (270 KB gzipped).

## Accounts (all derived and verified)

Each address below was derived with `findProgramAddressSync` and matched against real txs 21Z1Fd… (Buy) and 23QRS8… (Sell). The market and vault bumps also match the bytes stored in the market account (both are 253).

| # | account | derivation | flags |
|---|---------|-----------|-------|
| 0 | user | signer | S,W |
| 1 | market | PDA["market", mint] (bump at byte 238) | W |
| 2 | vault (wSOL, owner = market) | PDA["vault", market] (bump at byte 239) | W |
| 3 | creator_claim (wSOL, owner = market) | PDA["creator_claim", market] (bump at byte 240) | W |
| 4 | team_vault (wSOL) | PDA["team_vault", wSOL mint], global | W |
| 5 | reflection_vault (wSOL, owner = market) | PDA["reflection_vault", market] | W |
| 6 | RISE mint (Token-2022; extensions are only metadata pointer + metadata, no transfer fee) | constant | W |
| 7 | wSOL mint | constant | r |
| 8 | user wSOL ATA (classic Token) | ATA | W |
| 9 | user RISE ATA (Token-2022) | ATA | W |
| 10–13 | Token, Token-2022, ATA program, System | constants | r |
| 14 | event authority | PDA["__event_authority"] (the account does not exist) | r |
| 15 | RISE program | constant | r |

Instruction data:
- Buy: `66063d1201daebea | u64 lamports_in | u64 min_token_out`.
- Sell: `33e685a4017f83ad | u64 rise_in | u64 min_sol_out`.

The user pays from, and is paid into, the **wSOL ATA**. Native SOL is used only for the tx fee.

Compute use: about 250k–360k CU per buy at normal sizes (it grows with size, up to about 455k for very large buys) and about 85k–155k CU per sell.

## Fee schedule (verified: 93 historical trades, plus the state fields)

- The buy fee and the sell fee are each 12 500 ppm, i.e. 1.25%. They are stored as u32 at market offsets 245 and 249.
- Fee = `ceil(amount × 12500 / 1e6)`. Creator and team each receive `floor(fee/2)`; their shares are 5000/5000 bps, at offsets 261 and 263.
- **Buy**: the fee is charged on `lamports_in`. The curve prices `lamports_in − fee`. The vault is credited `lamports_in − 2·floor(fee/2)`, so an odd lamport stays in the vault.
- **Sell**: the fee is charged on gross SOL. The user receives `gross − fee`.
- The "4096-lamport discrepancy" mentioned in the task was not reproduced. Tx 21Z1's `lamports_in` is 523 999 059, which is exactly vault + fees.

## Market state layout (partial; 725 bytes, discriminator `dbbed53700e3c69a`)

| offset | type | meaning | evidence |
|---|---|---|---|
| 14..238 | 7 pubkeys | 46 = RISE mint, 78 = wSOL mint, 110 = Token program, 142 = vault, 206 = creator_claim. 14 and 174 are unidentified. | byte search |
| 238/239/240 | u8 | market / vault / creator_claim bumps | PDA derivation |
| 245 / 249 | u32 | buy / sell fee, ppm | fee math |
| 261 / 263 | u16 | creator / team share, bps | fee split |
| 267 | u64 | min trade in lamports (100 000) | LiteSVM: buy 99 999 fails with error 6401 and 100 000 succeeds; sells with gross under about 1e5 also fail with 6401 |
| 373 | u64 | 2; probably the curve kind (unverified) | |
| 381 | u64 | 11 572 119 644 971 349; roughly where the price curve steepens (unverified) | |
| 421 | u64 | supply (equals the mint supply) | events + mint |
| 429 / 437 | u64 | ledgers A (main/floor cash) and B (price reserve); A + B = vault balance | events, LiteSVM diffs |
| 469 / 477 | u64 | creator fees accrued / cumulative | increases by the creator fee on each trade |
| 485 | u64 | a cumulative reserve figure | events |
| 604 | u128 | changes on every trade (meaning unknown) | LiteSVM diff |

Everything else is undecoded. **Quotes do not depend on this table.**

## Pricing (measured shape only; not needed for quoting)

- The output is a pure function of account state. Changing the clock by up to 30 days did not change it.
- Shape, from a LiteSVM sweep:
  - flat floor ≈ 3.4196e-4 lamports per base unit below a supply of about 1.015e16;
  - a steeper ramp from there up to about 1.157e16;
  - roughly exponential above that, p ∝ exp(S/K) with K ≈ 7.0e15 units.
- Sells pay the floor part from A and the premium part from B.
- The program was **upgraded at slot 468145973**, after every historical tx in the sample. Historical outputs are therefore not replayed against the current binary; only the historical fees and account metas are.

## Limits / risks

- `quoteBuy` / `quoteSell` return `null` for:
  - amount ≤ 0 or ≥ 2^64;
  - a buy below 100 000 lamports;
  - a sell above supply;
  - anything the program rejects, e.g. a sell whose gross is below the min trade, or a disabled market.
- Market flags (buy disabled / sell disabled / paused) were **not located** in the state. If such a flag is set, the simulation fails and the quote is `null`, so the behavior is correct, but nothing exposes the flag directly.
- No per-tx maximum was found:
  - a 150 SOL buy succeeded on mainnet;
  - LiteSVM buys of 1k, 10k, 100k and 500k SOL succeeded, using up to about 455k CU;
  - LiteSVM sells of up to 1.3e16 units (99% of supply) succeeded, while selling the entire supply fails with error 14.
- Size the CU limit at ≥ 500k for buys.
- Not handled: a binary upgrade whose new code reads extra accounts that are not in the snapshot. In that case quotes would return `null` until the code is updated. Nothing silently gives a wrong number, because the program itself computes the result.
- LiteSVM runs bundled SPL Token and Token-2022 builds. Their outputs matched mainnet in every comparison above.

## Not verified

- A closed-form pricing formula.
- The meaning of most state fields, beyond the table above.
- Where the market flags live.
- The 4096-lamport case.
- Sells above about 0.055 SOL directly from a real RISE balance. These were verified only through the Buy+Sell round trip.
