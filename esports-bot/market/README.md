# market/ — Polymarket side (research + paper trading only, never places orders)

## Files
| script | does | writes |
|---|---|---|
| `record_prices.py` | discovers live Dota 2 events on Gamma (every 60 s), streams the CLOB market websocket for every token of the Match Winner + Game N Winner markets, writes one row per token per second | `data/prices.jsonl`, `data/ws_trades.jsonl`, `data/match_map.json`, log to stdout/stderr |
| `align.py` | joins `data/stream_events.jsonl` to prices, detects big stream events, reports mids at −60/−30/−10/0/+10/+30/+60 s | `data/aligned_events.jsonl` |
| `paper_trade.py` | rule on top of align.py's events, logs every signal (buy or skip, with reason) | `data/paper_trades.jsonl` |
| `make_synthetic_events.py` | builds a **synthetic** stream file from price moves with known planted lags, to test the pipeline | `data/synthetic/…` |
| `common.py` | time parsing, team-name matching, fee formula | |

## Run (from `esports-bot/`)
```bash
pip install websockets requests
# recorder (runs forever; picks up new live matches automatically)
setsid nohup python3 market/record_prices.py >> data/recorder.log 2>&1 < /dev/null &
pkill -f market/record_prices.py          # stop (SIGTERM -> clean flush)
#   --slugs dota2-gl-ch1-2026-11-13 ...   only those events;  --duration 600  stop after 10 min

python3 market/align.py                     # real stream events
python3 market/paper_trade.py --hold 60     # paper trades

# pipeline test without the stream reader
python3 market/make_synthetic_events.py
python3 market/align.py --stream data/synthetic/stream_events_synthetic.jsonl --out data/synthetic/aligned_synthetic.jsonl
python3 market/paper_trade.py --stream data/synthetic/stream_events_synthetic.jsonl --out data/synthetic/paper_trades_synthetic.jsonl
```
Override channel→market mapping: `--map esl_dota2=dota2-playti-huliga-2026-11-13`.

## prices.jsonl row
`ts_utc` (ms, wall-clock second boundary), `event_slug`, `market_type` (`moneyline` = match winner, `child_moneyline` = Game N winner), `game`, `current_game` (from Gamma `period`, refreshed every 60 s), `score`, `outcome`, `outcome_index`, `outcomes`, `token`, `bid`, `bid_size`, `ask`, `ask_size`, `mid`, `last` (last ws trade on this token), `last_ts`, `age_ms` (time since this token's book last changed), `src` (`ws` / `poll` = REST fallback / `stale` = ws down and no poll yet).

## Assumptions / caveats
- **Book**: kept from ws `book` snapshots + `price_change` deltas. Every 120 s the REST book is fetched and compared only (counts in the `stats` log line as `resync_match/resync_mismatch`); it is not overwritten, since REST can be older than ws deltas. While the ws is down, the REST book of every token is polled every 1 s.
- Both tokens of a market share one book, so `bid(A) ≈ 1 − ask(B)`; both are recorded anyway.
- `align.py` treats a mid as missing if the spread is > 20c (empty 1c/99c books carry no information) or the last row is > 5 s old.
- **Market chosen for an event**: the Game N Winner for `current_game` at that moment (Gamma `period`, which can lag game changes by ~1 min); falls back to the match winner.
- **Big event** (defaults): ≥3 kills for one side within 20 s of game clock with net swing ≥2, 30 s cooldown. Kill rows with confidence < 0.5 are dropped. Games inside one channel are split on `clock_start`, a clock reset, kills dropping, or a > 15 min gap.
- **Left/Right → outcome**: from `left_team`/`right_team` with fuzzy name + PandaScore acronym matching (`side_map_method=team_names`). Without names it votes over all kill changes in that game: does the left−right kill difference move outcome[0]'s mid the same way 15 s before → 30 s after? (`price_inference`, `side_map_conf` reflects the vote margin and count). `default_guess` (conf 0) means there was no evidence: treat those rows as unusable. Sides swap between games, so the mapping is redone for each game.
- `frac_before_stream` = (mid₀ − mid₋₆₀)/(mid₊₆₀ − mid₋₆₀), only when |total| ≥ 2c. `half_move_at_s` = when the move first reached 50 %, relative to the stream event (negative = the market moved first). The stream event time is the stream reader's `ts_utc`, so it already includes the reader's own detection latency.
- **Paper trades**: entry at the ask 1 s after the signal (Polymarket `secondsDelay`=1), taker fee 0.05·p·(1−p) per share on entry and on the timed exit, size capped at the recorded top-of-book ask size (deeper levels and queue position are not modelled). Hold-to-end is "won/lost" only if the recorded mid ends at ≥0.97 or ≤0.03. Otherwise it is marked at the last bid.
- The match→channel map comes from the PandaScore `running`/`upcoming` lists (token read from the file named by `PANDASCORE_KEY_FILE`, never stored in the repo). Some streams are on Kick or YouTube, not Twitch (e.g. IAC vs Red John → `kick.com/epldota_en2`).
- The outbound proxy sometimes rejects CONNECT (403/502) to polymarket/pandascore. The recorder retries: ws after 1 s, discovery after 10–60 s, PandaScore after 60 s.
