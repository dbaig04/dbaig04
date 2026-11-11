# RISE ⇄ Meteora DLMM arbitrage bot

Arbitrage between RISE's native mint/redeem program (`RiseP9yY…`) and its Meteora DLMM
RISE/SOL pool (`4xjgBH…`). It copies the strategy of the reference wallet
`24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU`:

| direction       | leg 1                                   | leg 2                                         |
|-----------------|-----------------------------------------|-----------------------------------------------|
| `mintThenSell`  | RISE **Buy**: wSOL lamports in → RISE   | DLMM **exact-in** swap RISE → SOL             |
| `buyThenRedeem` | DLMM **exact-out** swap SOL → exact RISE | RISE **Sell**: exact RISE → lamports          |

Each trade is **one legacy transaction**: `SetComputeUnitLimit`, `SetComputeUnitPrice`, leg 1, leg 2.
Both legs run atomically, so the profit floor is **enforced on-chain**:

- leg 1's limit is the exactly quoted amount: the RISE min-out of the Buy, or the max-in of the DLMM exact-out buy.
  `LEG_SLIPPAGE_BPS` can loosen it (default 0).
- the final leg's min-out is `lamportsIn + pad + execution cost + floor`, where lamportsIn is the **net** wSOL spend
  (buyThenRedeem: DLMM max-in minus the host-fee rebate paid back to the user's own input account), execution cost is
  base + priority + tip as chosen for this trade (`src/engine/fees.ts`), and pad covers the part of that SOL rebate a
  fee-rate drop before landing could remove (0 for mintThenSell). A tx that lands therefore always clears the floor
  *after every cost*. If the min-out fails the tx reverts and only the fee is lost. The reference wallet uses
  `+100,000` without the fee. This bot also covers the fee, in both directions.

Funds stay in a persistent **wSOL ATA** (classic Token program) and a **RISE ATA** (Token-2022). There is no
wrap or unwrap per trade.

## Quick start

```bash
npm install
# read-only paper trading against the reference wallet's accounts (default MODE=simulate)
NODE_USE_ENV_PROXY=1 npx tsx src/main.ts        # NODE_USE_ENV_PROXY only needed behind an HTTPS proxy
npx tsx src/engine/report.ts                    # summarize data/ledger.jsonl
npm test                                        # unit tests (engine tests: test/engine*.test.ts)
npx tsc -p .                                    # typecheck
```

### Going live

```bash
# 1. one-time: create ATAs if missing and wrap SOL (prints + simulates the tx, asks you to type CONFIRM)
KEYPAIR_PATH=~/bot.keypair.json WRAP_LAMPORTS=2000000000 npx tsx src/engine/setup.ts
# 2. run live (all three are required)
MODE=live KEYPAIR_PATH=~/bot.keypair.json CONFIRM_LIVE=yes RPC_URL=https://<your-rpc> npx tsx src/main.ts
```

## Configuration (env)

| var | default | meaning |
|-----|---------|---------|
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC endpoint. Use a private one for live trading. |
| `MODE` | `simulate` | `simulate` or `live`. Live also needs `KEYPAIR_PATH` **and** `CONFIRM_LIVE=yes`. |
| `KEYPAIR_PATH` | – | Solana CLI JSON keypair. Optional in simulate mode. |
| `SIM_USER` | reference wallet | Wallet to simulate as when no keypair is given. Its wSOL/RISE ATAs supply balances, so the whole pipeline runs read-only. |
| `PROFIT_FLOOR_LAMPORTS` | `100000` | Min net profit after fees. Used by the optimizer, the sim check and the on-chain min-out. |
| `PRIORITY_FEE_LAMPORTS` | `50000` | Target priority fee per tx. CU price = floor(fee·1e6 / CU limit). |
| `BASE_FEE_LAMPORTS` | `5000` | Base fee per signature. |
| `MAX_TRADE_LAMPORTS` | `100000000` | Max lamports spent on leg 1 (0.1 SOL; also a hard risk limit). |
| `MIN_TRADE_LAMPORTS` | `1000000` | Smallest trade considered. |
| `MAX_WSOL_LAMPORTS` | `5000000000` | Max share of the wSOL ATA balance the bot may use. |
| `LEG_SLIPPAGE_BPS` | `0` | Slippage on the intermediate leg. 0 = exact quoted amount. |
| `SIM_TOLERANCE_LAMPORTS` / `SIM_TOLERANCE_BPS` | `20000` / `1000` | Max allowed gap between simulated and quoted profit (whichever is larger). |
| `CU_HEADROOM_BPS` | `11500` | CU limit = simulated units × 1.15. |
| `POLL_INTERVAL_MS` | `1000` | Tick period. With a gRPC/Shreds feed: the max time between ticks (the loop is event-driven). |
| `LEDGER_PATH` | `data/ledger.jsonl` | Append-only ledger. |
| `MAX_SESSION_LOSS_LAMPORTS` | `2000000` | Stops the bot when the session's realized net falls below −this. |
| `REBROADCAST_MS` | `2000` | Rebroadcast period of the RPC sender. |
| `COMMITMENT` | `confirmed` | State and confirmation commitment. |
| `SEND_RPC_URL` | – | Delivery endpoint for `sendRawTransaction` (ERPC SWQoS). Status polling stays on `RPC_URL`. |
| `SEND_RPC_WARM_MS` | `0` | Keep the send connection warm with a cheap request every N ms (0 = off). |
| `WS_URL` | derived | WebSocket endpoint for `RPC_URL`. |
| `GRPC_ENDPOINT` / `GRPC_X_TOKEN` | – | Yellowstone Geyser gRPC (ERPC Geyser gRPC). Token goes in the `x-token` header. |
| `GRPC_COMMITMENT` | `COMMITMENT` | `processed` / `confirmed` / `finalized` for the stream. |
| `GRPC_PING_MS` / `GRPC_STALE_MS` / `GRPC_DEBOUNCE_MS` | `10000` / `3000` / `3` | Keepalive ping, staleness cutoff (then RPC poll), per-slot debounce (flushes earlier on the slot status). |
| `GRPC_RECONNECT_MIN_MS` / `GRPC_RECONNECT_MAX_MS` | `250` / `15000` | Reconnect backoff. |
| `SHREDSTREAM_ENDPOINT` / `SHREDSTREAM_X_TOKEN` | – | ShredStream entries (ERPC Shreds). Hint only, never applied to state. |
| `SHREDSTREAM_SERVER_FILTER` | `0` | Ask ERPC to pre-filter entries by account (marked experimental by ERPC). |
| `SHREDSTREAM_STALE_MS` | `5000` | Recycle the shred stream after this long without data. |
| `SHREDS_RESOLVE_ALTS` | `1` | Resolve lookup tables of relevant-looking v0 txs via RPC. |
| `SHREDS_HOLD_ON_COMPETING_ARB` / `SHREDS_HOLD_WINDOW_MS` | `0` / `1500` | Skip a trade while a competing arb on the pool is pending. Off by default. |
| `LATENCY_SUMMARY_MS` | `60000` | Period of the `latency` summary ledger row (0 = off). |
| `DELIVERY` | `rpc` | `rpc` (sendRawTransaction to `SEND_RPC_URL`/`RPC_URL`) or `jito` (single-tx bundle with an in-tx tip). `ab` = live A/B, refused unless `MODE=live`, `CONFIRM_LIVE=yes`, `DELIVERY_COMPARE_LIVE=yes`. |
| `JITO_BLOCK_ENGINE_URL` / `JITO_UUID` / `JITO_TIP_ACCOUNTS_TTL_MS` | `https://mainnet.block-engine.jito.wtf` / – / `600000` | Jito block engine, optional `x-jito-auth`, tip-account cache lifetime. |
| **risk limits** | | **Defaults are the operator-specified limits (see Safety).** |
| `MAX_PRIORITY_FEE_LAMPORTS` / `MAX_TIP_LAMPORTS` | `50000` / `50000` | Per-tx caps. |
| `MAX_EXEC_COST_BPS_OF_PROFIT` | `1000` | priority + tip ≤ 10% of the expected profit before execution costs (out − in). |
| `MIN_NET_PROFIT_LAMPORTS` | `100000` | Min expected net after base + priority + tip. |
| `MAX_DAILY_EXEC_COST_LAMPORTS` | `5000000` | Halt for the UTC day at Σ(fee + tip) of landed txs (success or failure). Persisted. |
| `MAX_DAILY_LOSS_LAMPORTS` | `10000000` | Halt for the UTC day at this realized SOL loss. Persisted. |
| `MAX_CONSECUTIVE_FAILURES` / `EXPIRED_COUNTS_AS_FAILURE` | `3` / `1` | Halt after N unsuccessful txs in a row (persisted until `estop.ts clear-failures`). |
| `MAX_STALE_SLOTS` / `MAX_STALE_MS` | `8` / `3000` | Refuse to build/send on a snapshot this far behind the newest slot seen / this old. |
| `SIM_MAX_AGE_MS` | `3000` | The sender refuses a tx whose exact message did not simulate OK within this window. |
| `KILL_FILE` / `RISK_STATE_PATH` / `PID_FILE` | `data/STOP` / `data/risk-state.json` / `data/bot.pid` | E-stop file, persistent risk state, pid for `estop.ts`. |
| `UPGRADE_CHECK_MS` | `30000` | Programdata deploy-slot check of the RISE and Meteora DLMM programs. |

All variables, with placeholders, are listed in [`deploy/.env.example`](deploy/.env.example).

## Safety defaults

- **Simulate mode is the default.** It never signs or sends. With no keypair it simulates as `SIM_USER`, with
  `sigVerify: false`. None of the risk limits below enables live trading.
- **Live mode needs three explicit opt-ins**: `MODE=live`, a keypair, and `CONFIRM_LIVE=yes`.
- **Every tx is simulated before sending, and the sim must pass.** The bot simulates the exact final message (CU =
  units × 1.15, tip ix included). A tx is rejected when:
  - the simulation errors,
  - Δ wSOL − fee < floor,
  - the RISE balance would drop,
  - simulated profit deviates from the quote beyond tolerance.
- **Simulate-before-submit is enforced in the sender.** The engine only submits through `GuardedSender`, which refuses
  (nothing is broadcast) outside `MODE=live`, for a message hash that did not simulate OK within `SIM_MAX_AGE_MS`, and
  for a signature it already submitted.
- **The profit floor is enforced on-chain** through the final leg's min-out, net of base fee, priority fee and tip.

### Risk limits (`src/engine/risk.ts`; defaults = operator limits, env-overridable)

| limit | default | when |
|---|---|---|
| max input per trade | 100,000,000 lamports (0.1 SOL) | optimizer cap + pre-build + pre-send check |
| max priority fee / tx | 50,000 lamports | pre-send |
| max tip / tx | 50,000 lamports | pre-send (Jito) |
| priority + tip | ≤ 10% of expected profit before execution costs | pre-send |
| min expected net profit | 100,000 lamports after base + priority + tip | optimizer floor + pre-send |
| daily execution costs | stop at 5,000,000 lamports Σ(fee + tip) of landed txs (success or failure), regardless of profit | after each outcome; a tx that would cross it is refused |
| daily realized loss | stop at 10,000,000 lamports | after each outcome |
| consecutive failures | stop after 3 (landed failures; expired/dropped count too unless `EXPIRED_COUNTS_AS_FAILURE=0`) | after each outcome |

- **Daily limits persist** in `data/risk-state.json` keyed by UTC day: a restart the same day stays halted. The
  process idles (no trading) and resumes at 00:00 UTC. The failure streak persists across days until
  `npx tsx src/engine/estop.ts clear-failures` (with the bot stopped).
- **Exactly one tx in flight.** A submission is claimed (and persisted) before broadcast and released only after its
  final status is resolved: confirmed, failed, or expired by blockhash (block height past `lastValidBlockHeight`, then
  signature status re-checked with history). A tx left in flight by a crash is resolved at the next start (and
  recorded) before anything else is sent.
- **Duplicate protection.** A signature or message hash is never submitted twice (last 64 persisted); the only
  repeat is the sender's own rebroadcast of the identical signed tx. An opportunity identical to the one in flight, or
  to one that just failed in the same slot, is refused.
- **Stale state.** Refuse to build or send when the snapshot slot is more than `MAX_STALE_SLOTS` behind the newest slot
  seen (state feed, simulation context, statuses), older than `MAX_STALE_MS`, or the provider reports stale data.
- **Program upgrades.** RISE already pauses quoting during an upgrade. In addition the 45-byte programdata header
  (deploy slot + authority) of **RISE** (`2jmivX…XB1E`) and **Meteora DLMM** (`HZcJwc…bEhu`, deploy slot 423,977,638 at
  the time of writing) is read at start and every `UPGRADE_CHECK_MS`; any change, or the RISE venue's `programStale`
  flag, halts trading until restart. Both baselines go into the `start` ledger row.
- **Emergency stop.** `touch data/STOP` (checked every tick), `kill -USR1 <pid>`, or
  `npx tsx src/engine/estop.ts [reason]` (writes the kill file and signals the pid in `data/bot.pid`). Once tripped it
  stays tripped for the life of the process, and the kill file keeps it tripped across restarts until removed
  (`estop.ts clear`) **and** the bot is restarted. `estop.ts status` shows the file, pid and risk state.
- **Every halt is logged** as a `halt` ledger row (reason + detail); non-halting refusals as `risk` rows.
- **Session loss limit.** The older kill-switch still stops the bot once the session's realized net falls past
  `MAX_SESSION_LOSS_LAMPORTS`.
- **Graceful shutdown.** SIGINT/SIGTERM finishes the current tick and waits for any in-flight tx. A second signal
  exits immediately.

### Delivery

- `DELIVERY=rpc` (default): `RpcSender`, sendRawTransaction (skipPreflight, maxRetries 0) to `SEND_RPC_URL` (ERPC
  SWQoS) or `RPC_URL`, rebroadcast until resolved.
- `DELIVERY=jito`: `JitoSender`, one `sendBundle` holding the single arb tx; the tip is a transfer to a random tip
  account (from `getTipAccounts`, cached) inside the same tx, sized by the shared fee/tip policy (`fees.ts`) and
  budgeted in the on-chain min-out. Never falls back to public RPC. In simulate mode the tip ix is simulated but
  nothing is sent.
- `npx tsx src/engine/delivery-compare.ts` writes `src/engine/DELIVERY.md`: the exact per-service cost model
  (RPC failures pay fees; failing Jito bundles do not land and cost 0), **estimated** expected value under assumed
  landing rates, and read-only market data (recent prioritization fees for the pool/RISE market, Jito tip accounts,
  tip floor if reachable). Landing rates are not measured; the live A/B (`--live`) sends real transactions and needs
  `MODE=live CONFIRM_LIVE=yes DELIVERY_COMPARE_LIVE=yes` and the operator's approval.

## Architecture

```
src/types.ts            shared contracts (RiseVenue, DlmmVenue, StateSource, Opportunity)
src/rise/               RiseNative  implements RiseVenue  (exact Buy/Sell quotes + ixs, no I/O)
src/meteora/            MeteoraDlmm implements DlmmVenue  (exact bin-walk quotes + Swap2 ixs, no I/O)
src/config.ts           env config + safety gating
src/main.ts             loop: tick → sleep; signal handling; loss limit
src/engine/
  state.ts              StateManager: getSlot; if the slot advanced, ONE getMultipleAccountsInfo (chunks of 100,
                        pinned with minContextSlot) for the union of all sources' accounts(); refetches in the same
                        tick if a source's account set grows (e.g. bin arrays). TokenBalances = user's wSOL/RISE ATAs.
                        StateProvider interface: PollingProvider (= StateManager, default) | GrpcProvider (src/feeds).
  optimizer.ts          two-stage per direction. Stage 1 on RISE *Fast quotes (3-point exact grid over the allowed
                        size range, rebuilt only when RISE state changes) + exact DLMM quotes: grid → golden-section
                        in the best brackets; skip the direction (0 exact RISE calls) if even that estimate cannot
                        reach the floor. Stage 2: exact RISE quote at the best ≤2 candidates + one locally corrected
                        re-centre (≤4 exact calls). Objective = NET profit: out − net in (DLMM netIn) − base −
                        priority − tip; RISE host-fee rebate (mintThenSell) is reported as residual, not profit.
                        Domain is lamports in (mintThenSell) or exact RISE out (buyThenRedeem, gross in ≤ cap).
  fees.ts               chooseExecutionFees(): priority ≤ 50k, tip ≤ 50k (0 without a tipping sender),
                        priority + tip ≤ 10% of expected profit before execution costs (pure, shared with senders)
  tx.ts                 compute-budget ixs + leg ixs (venue.*Ix) with the mins above [+ tip transfer]; fee math
  blockhash.ts          background blockhash cache (refresh every 2 s, stale after 20 s): no RPC on the hot path
  bench.ts              record mainnet snapshots / offline stage timings / live simulate-mode run → BENCH.md
  simulate.ts           simulateTransaction (sigVerify false, replaceRecentBlockhash, post-state of the wSOL and
                        RISE ATAs) → decoded SPL amounts → simulated profit + checks + CU limit
  latency.ts            per-tick latency marks (update received → refreshed → decision → simulated → sent)
  sender.ts             Sender interface; RpcSender = sendRawTransaction(skipPreflight, maxRetries 0) +
                        own rebroadcast loop until confirmed / failed / blockhash expiry; JitoSender (bundle + tip);
                        GuardedSender (live only, simulated-OK message, no duplicates); resolveSignature
  risk.ts               RiskGuard (limits, daily persistence, halts, duplicates, one-in-flight, stale state),
                        ProgramUpgradeGuard (RISE + DLMM programdata), crash-orphan resolution
  estop.ts              emergency stop helper (kill file + SIGUSR1; status / clear / clear-failures)
  delivery-compare.ts   RPC vs Jito cost model, read-only fee/tip data, gated live A/B -> DELIVERY.md
  engine.ts             ArbEngine.tick(): refresh → optimize both (cached while neither venue changed) → build
                        (cached blockhash; CU learned from the last final sim, else pre-sim) → final sim → [live]
                        send → realize
  ledger.ts             JSONL ledger + realized-PnL math from getTransaction (actual fee, Δ wSOL / Δ RISE / Δ native)
  report.ts             PnL report for the ledger, or for a directory of saved reference-wallet txs
  setup.ts              one-time ATA creation (Token + Token-2022) and SOL wrap, gated by CONFIRM
```

src/feeds/              optional ERPC infrastructure, all env-driven (src/feeds/index.ts wires it)
  grpc.ts               GrpcProvider: Yellowstone account+slot subscription for the union of all sources' accounts()
                        (venues + user ATAs). Store ordered by (slot, write_version); seeded by RPC on every
                        (re)connect and for accounts added later (bin arrays → resubscribe on the live stream).
                        Per-slot debounce → ChangeSignal → event-driven main loop. Ping keepalive, reconnect with
                        backoff; stale/disconnected/unseeded → falls back to the PollingProvider (StateManager).
  shreds.ts             ShredStream SubscribeEntries client + Vec<Entry> decoder (legacy, v0, v1 txs; Alpenglow
                        markers skipped). Flags txs touching the RISE program, the pool or its reserves; logs them,
                        wakes the engine, feeds PendingActivity (optional hold rule). Never used as state.
  http.ts               keep-alive undici fetch for RPC_URL / SEND_RPC_URL
  signal.ts             ChangeSignal (coalescing wake-up)

## Running on the ERPC VPS

Run the bot on the ERPC VPS, in the same region as your ERPC RPC, Geyser gRPC and Shreds endpoints. Co-location keeps
the path from Geyser update to decision to sent tx short. All three ERPC services are optional and independent:

| service | env | effect |
|---|---|---|
| ERPC RPC / SWQoS | `RPC_URL`, `SEND_RPC_URL` | reads/sims on `RPC_URL`; txs sent (and rebroadcast until expiry) to `SEND_RPC_URL` over a warm keep-alive connection |
| ERPC Geyser gRPC | `GRPC_ENDPOINT`, `GRPC_X_TOKEN` | streamed account state instead of per-tick polling; the loop re-optimizes on each relevant update |
| ERPC Shreds | `SHREDSTREAM_ENDPOINT` | early view of pending competing arbs and pool swaps (logged; optional hold) |

Without them the bot behaves exactly as before: it polls `RPC_URL` every `POLL_INTERVAL_MS`.

```bash
# on the VPS (Node 22)
sudo useradd --system --create-home --home-dir /opt/rise-arb arb
sudo -u arb git clone <your repo> /opt/rise-arb/app && cd /opt/rise-arb/app/bot && sudo -u arb npm ci
sudo install -d -m 0750 -o root -g arb /etc/rise-arb
sudo install -m 0640 -o root -g arb deploy/.env.example /etc/rise-arb/bot.env   # fill in your ERPC endpoints/tokens
sudo -u arb mkdir -p data
sudo install -m 0644 deploy/rise-arb.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rise-arb
journalctl -u rise-arb -f
```

- **`MODE` defaults to `simulate`.** The service paper-trades until you set `MODE=live`, `KEYPAIR_PATH` (e.g.
  `/etc/rise-arb/bot.keypair.json`, mode 0440 root:arb) and `CONFIRM_LIVE=yes` in `/etc/rise-arb/bot.env`.
- The unit runs `node --import tsx` directly, so SIGTERM reaches the bot. It finishes the current tick and any in-flight
  tx (`TimeoutStopSec=150`). It restarts only on crashes. A clean stop, such as the session loss limit, stays stopped.
- Check at startup: the `infra:` log line and the `start` ledger row show which feeds are active. Tokens and URL paths
  are redacted.
- Health: `grpc feed healthy` / `grpc feed not usable … RPC polling` log lines mark the fallback transitions. Shred
  hits are logged as `[shred <slot>] pending arb|pool-swap|rise …` with the competitor's fee payer and priority fee.
- Latency: opportunity, final simulation, hold and outcome rows carry `latency` = {source, trigger, queueMs, refreshMs,
  decisionMs, simulatedMs, sentMs}. All values except refreshMs are measured from the moment the update was received.
  A `latency` summary row (p50/p90/max update→decision, ticks by source) is written every `LATENCY_SUMMARY_MS`.

### Ledger and realized PnL

`data/ledger.jsonl` gets one JSON object per event:

- `start`, `opportunity` (the plan), `simulation` (stage `pre` and `final`, with reasons), `submission`,
  `outcome`, `error`, `stop`, `hold` (competing-arb hold, opt-in), `latency` (periodic summary),
  `halt` (every risk halt), `risk` (refused plans), `balances` (wSOL/RISE snapshot at start/stop) and
  `reconcile` (startup: on-chain balances vs last snapshot + Σ outcome deltas, with drift).
- Outcome rows also carry `exec` {base, priority, tip}, `tradingProfit`, `failedCost`, `residualRise`, `expected`
  (final-sim deltas, fee, tip), `drift` (actual − expected) and `latencyMs` {decision, built, simulated, sent, landed,
  slotsToLand} from the update's receive time.
- Bigints are stored as decimal strings.

Outcomes always come from the landed transaction (`getTransaction`):

- the actual `fee`
- Δ of the wSOL ATA token amount
- Δ of the RISE ATA token amount
- Δ of native SOL
- `netLamports` = Δ wSOL + Δ native

How each case is recorded:

- **Failed-but-landed txs** record their fee as a loss.
- **Dropped or expired txs** record 0.
- **RISE residue** is reported separately. The DLMM host-fee rebate on RISE input leaves a little RISE behind on
  `mintThenSell`. The report values it at the trade-time mark as an estimate.

`npx tsx src/engine/report.ts [--ledger path] [--days N]` prints, per UTC day and all-time, separate sections:
`[trading]` realized trading profit, `[costs]` base / priority / tip, `[failed]` failed-attempt costs, `[net]`,
`[residual]` RISE residue (valued separately, never in realized SOL), `[reconcile]` drift vs simulation, `[latency]`
per stage, `[delivery]` per service, `[halts]`, `[risk]`; then the paper section. The older summary
(`summarize`, used for the reference backfill) prints:

- counts: submitted, landed, ok, failed, dropped
- gross, fees, failed-tx cost and net
- the RISE residual
- win rate and a per-direction breakdown
- paper PnL of passing sims, and the top sim-rejection reasons

### Reference-wallet backfill

`npx tsx src/engine/report.ts --reference <dir> [--wallet <pubkey>]` reruns the same ledger math over a directory of
saved `getTransaction` JSON responses. Only txs that contain both a RISE and a DLMM top-level instruction count as
arbs. Deposits, wraps and exits are listed separately.

On 100 saved txs of the reference wallet (slots 467,774,316 – 468,135,211):

- **94 arb txs**: 92 succeeded and 2 failed with slippage error 6405, which cost 55,001 lamports each.
- **Gross** 24.2088 SOL, **fees** 0.00464 SOL, **net** 24.2042 SOL. Win rate is 97.9%.
- **Residual RISE**: the sum is 90,276,131,404 raw units. That equals the wallet's live RISE ATA balance, which
  cross-checks the token-delta math.

## Verification status (measured 2026-11-11, simulate mode only, no live sends)

| What | Result | How |
|---|---|---|
| RISE quotes vs mainnet `simulateTransaction` | 14/14 exact (buy 0.001–150 SOL, sell incl. round-trips) | `src/rise/validate.ts` |
| DLMM quotes vs mainnet simulation | 25/25 exact (exact-in/out, both sides, 0.001–200 SOL) | `src/meteora/validate.ts` |
| Two-leg arb tx composition on mainnet (reference wallet, test-only negative floor) | executes, Δ wSOL = expected exactly; quoted+1 min-out fails as it should | audit script (not shipped) |
| Update → tx built, worst case offline (both venues changed + arb) | 12.1 ms median / 17.7–22.2 ms p95 across runs | `src/engine/bench.ts offline` |
| Live data → decision (public RPC polling) | 0.6 / 1.4 ms; RPC poll itself 145 / 181 ms | `bench.ts live` |
| Live `simulateTransaction` RTT (public RPC) | 50–64 ms median, 84 ms p95 | `bench.ts live --force-build` |
| Tests | 103 pass, `tsc` clean | `npm test` |

Fixed during the audit (each with a regression test):
- `DELIVERY=ab` Jito arm added a tip the on-chain min-out did not cover.
- Max-input risk gates checked net instead of gross spend.
- Simulated profit ignored an in-tx Jito tip.
- Landed txs whose `getTransaction` never returned were booked as free drops (under-counted daily cost/loss limits).
- A hung LiteSVM worker blocked the event loop (and with it the e-stop); the oracle now uses a non-blocking pipe with a 250 ms per-quote deadline, kills and respawns the worker.

Known limitations:
- No live sends were made: submission, landing rate, landing latency, and Jito vs RPC comparison are **unmeasured**. The live A/B harness exists but requires explicit approval flags.
- ERPC gRPC, ShredStream and SWQoS paths are tested against local mocks built from ERPC's published client/protos only — not against ERPC servers.
- First tick per direction (and after a failed final sim) pre-simulates to learn the CU limit, adding one sim RTT (~65 ms live) before the final tx; steady state is ~2 ms.
- DLMM variable-fee branch with non-zero volatility reference was not hit in live validation (pool was idle); it is covered by historical-tx replay only.
- gRPC reseed after reconnect with `GRPC_COMMITMENT=processed` can miss a change made during the gap until the account changes again (default commitment is `confirmed`).
- RISE pricing has no closed form here: quotes come from executing the deployed program; a program upgrade halts trading until restart.
- Expired (never-landed) txs count toward the 3-consecutive-failure stop (`EXPIRED_COUNTS_AS_FAILURE=1`, conservative).
