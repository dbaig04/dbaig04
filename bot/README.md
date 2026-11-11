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
- the final leg's min-out is `lamportsIn + PROFIT_FLOOR_LAMPORTS + txCost`, where txCost is the base fee plus the
  priority fee. A tx that lands therefore always clears the floor *after fees*. If the min-out fails the tx reverts and
  only the fee is lost. The reference wallet uses `+100,000` without the fee. This bot also covers the fee, in both
  directions.

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
| `MAX_TRADE_LAMPORTS` | `5000000000` | Max lamports spent on leg 1. |
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
| `GRPC_PING_MS` / `GRPC_STALE_MS` / `GRPC_DEBOUNCE_MS` | `10000` / `3000` / `20` | Keepalive ping, staleness cutoff (then RPC poll), per-slot debounce. |
| `GRPC_RECONNECT_MIN_MS` / `GRPC_RECONNECT_MAX_MS` | `250` / `15000` | Reconnect backoff. |
| `SHREDSTREAM_ENDPOINT` / `SHREDSTREAM_X_TOKEN` | – | ShredStream entries (ERPC Shreds). Hint only, never applied to state. |
| `SHREDSTREAM_SERVER_FILTER` | `0` | Ask ERPC to pre-filter entries by account (marked experimental by ERPC). |
| `SHREDSTREAM_STALE_MS` | `5000` | Recycle the shred stream after this long without data. |
| `SHREDS_RESOLVE_ALTS` | `1` | Resolve lookup tables of relevant-looking v0 txs via RPC. |
| `SHREDS_HOLD_ON_COMPETING_ARB` / `SHREDS_HOLD_WINDOW_MS` | `0` / `1500` | Skip a trade while a competing arb on the pool is pending. Off by default. |
| `LATENCY_SUMMARY_MS` | `60000` | Period of the `latency` summary ledger row (0 = off). |

All variables, with placeholders, are listed in [`deploy/.env.example`](deploy/.env.example).

## Safety defaults

- **Simulate mode is the default.** It never signs or sends. With no keypair it simulates as `SIM_USER`, with
  `sigVerify: false`.
- **Live mode needs three explicit opt-ins**: `MODE=live`, a keypair, and `CONFIRM_LIVE=yes`.
- **Every tx is simulated before sending, and the sim must pass.** The bot simulates twice: once with a generous CU
  limit to measure usage, then again on the exact final message with CU = units × 1.15. A tx is rejected when:
  - the simulation errors,
  - Δ wSOL − fee < floor,
  - the RISE balance would drop,
  - simulated profit deviates from the quote beyond tolerance.
- **The profit floor is enforced on-chain** through the final leg's min-out, net of fees.
- **One tx in flight at most.** Ticks are serialized, and a tick does not return until its tx confirms, fails or
  expires.
- **Session loss limit.** A kill-switch stops the bot once the session's realized net falls past
  `MAX_SESSION_LOSS_LAMPORTS`.
- **Graceful shutdown.** SIGINT/SIGTERM finishes the current tick and waits for any in-flight tx. A second signal
  exits immediately.

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
  optimizer.ts          per direction: log-spaced scan (+ linear points) → golden-section in the brackets of the
                        top-5 grid points → integer pattern search → exhaustive ±32 window. Domain is lamports in
                        (mintThenSell) or exact RISE out (buyThenRedeem, bounded by binary search so that
                        lamports in ≤ min(max trade, wSOL balance, max wSOL)). Profit = out − in − txCost, using
                        worst-case amounts under the configured slippage.
  tx.ts                 compute-budget ixs + leg ixs (venue.*Ix) with the mins above; fee math
  simulate.ts           simulateTransaction (sigVerify false, replaceRecentBlockhash, post-state of the wSOL and
                        RISE ATAs) → decoded SPL amounts → simulated profit + checks + CU limit
  latency.ts            per-tick latency marks (update received → refreshed → decision → simulated → sent)
  sender.ts             Sender interface; RpcSender = sendRawTransaction(skipPreflight, maxRetries 0) +
                        own rebroadcast loop until confirmed / failed / blockhash expiry. (Jito: add another Sender.)
  engine.ts             ArbEngine.tick(): refresh → optimize both → build → sim → final sim → [live] send → realize
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
  `outcome`, `error`, `stop`, `hold` (competing-arb hold, opt-in), `latency` (periodic summary).
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

`npx tsx src/engine/report.ts [--ledger path]` prints:

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
