#!/usr/bin/env python3
"""Paper-trade a simple 'stream is faster than the book' rule on recorded data. NO real orders.

Rule: on each big stream event (from align.py) favouring team X, if X's ask has moved
less than --max-premove (default 40%) of a typical move over the previous --lookback
seconds, buy X at the ask available --entry-delay s later (stream-reader latency +
Polymarket's 1 s marketable-order delay), paying the taker fee 0.05*p*(1-p)/share.
Fill size is capped by the recorded top-of-book ask size (deeper levels not modelled).

Exit (both are computed and logged for every trade):
  * timed: sell at the bid --hold s after entry (taker fee again)
  * hold:  hold to game end -> $1 / $0 if the recorded mid ends >=0.97 / <=0.03, else
           marked at the last recorded bid and flagged unresolved

Writes data/paper_trades.jsonl (rewritten on each run; trade_id is deterministic).
"""
import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from align import analyse, load_prices, pick_series  # noqa: E402
from common import DATA, iso, parse_ts, taker_fee  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stream", default=os.path.join(DATA, "stream_events.jsonl"))
    ap.add_argument("--prices", default=os.path.join(DATA, "prices.jsonl"))
    ap.add_argument("--match-map", default=os.path.join(DATA, "match_map.json"))
    ap.add_argument("--out", default=os.path.join(DATA, "paper_trades.jsonl"))
    ap.add_argument("--map", action="append", default=[], help="override channel=event_slug")
    ap.add_argument("--typical-move", type=float, default=None,
                    help="typical favourable move in $ (default: median |60s move| of detected events, else 0.10)")
    ap.add_argument("--max-premove", type=float, default=0.4)
    ap.add_argument("--lookback", type=float, default=60)
    ap.add_argument("--entry-delay", type=float, default=1.0)
    ap.add_argument("--hold", type=float, default=60, help="timed exit after N s")
    ap.add_argument("--stake", type=float, default=100.0, help="$ notional per trade")
    ap.add_argument("--max-ask", type=float, default=0.95, help="skip if ask above this")
    ap.add_argument("--kills", type=int, default=3, help="big-event threshold passed to align.py")
    ap.add_argument("--window", type=float, default=20.0)
    ap.add_argument("--net", type=int, default=2)
    a = ap.parse_args()
    ov = {k.lower(): v for k, v in (x.split("=", 1) for x in a.map)}

    events, _ = analyse(a.stream, a.prices, a.match_map, ov, a.kills, a.window, a.net)
    if not events:
        print("no big stream events -> no trades")
    series, _ = load_prices(a.prices, {e["event_slug"] for e in events} or None)
    moves = [abs(e["total_move"]) for e in events if e["total_move"] is not None and abs(e["total_move"]) >= 0.02]
    typical = a.typical_move or (statistics.median(moves) if len(moves) >= 5 else 0.10)

    trades = []
    for e in events:
        s, mtype, game = pick_series(series, e["event_slug"], e["game"], e["favoured"])
        if s is None:
            continue
        t0 = parse_ts(e["ts_utc"])
        ask_now, ask_prev = s.at(t0, "ask"), s.at(t0 - a.lookback, "ask")
        rec = {"trade_id": f"{e['event_slug']}|{e['ts_utc']}|{e['favoured']}", "signal_ts": e["ts_utc"],
               "event_slug": e["event_slug"], "market_type": mtype, "game": game, "side": e["favoured"],
               "side_map_method": e["side_map_method"], "side_map_conf": e["side_map_conf"],
               "ask_at_signal": ask_now, "ask_lookback": ask_prev, "typical_move": round(typical, 4)}
        if ask_now is None or ask_prev is None:
            trades.append({**rec, "action": "skip", "reason": "no price data around signal"})
            continue
        pre = ask_now - ask_prev
        rec["ask_premove"] = round(pre, 4)
        if pre >= a.max_premove * typical:
            trades.append({**rec, "action": "skip", "reason": f"ask already moved {pre:+.3f} >= {a.max_premove}*typical"})
            continue
        te = t0 + a.entry_delay
        entry, ask_sz = s.at(te, "ask"), s.at(te, "ask_size")
        if entry is None or entry > a.max_ask:
            trades.append({**rec, "action": "skip", "reason": f"entry ask {entry} unavailable or > max"})
            continue
        shares = a.stake / entry
        capped = ask_sz is not None and ask_sz < shares
        if capped:
            shares = ask_sz  # only top-of-book size is assumed fillable
        fee_in = taker_fee(entry) * shares
        # timed exit
        bid_x = s.at(te + a.hold, "bid", max_stale=10)
        timed = None
        if bid_x is not None:
            timed = round((bid_x - entry) * shares - fee_in - taker_fee(bid_x) * shares, 2)
        # hold to end of recorded data
        last_i = max((k for k in range(len(s.ts)) if s.bid[k] is not None or s.ask[k] is not None), default=None)
        final_mid = None
        if last_i is not None:
            b, k = s.bid[last_i], s.ask[last_i]
            final_mid = (b + k) / 2 if b is not None and k is not None else (b if b is not None else k)
        if final_mid is not None and final_mid >= 0.97:
            hold_pnl, resolved = round((1 - entry) * shares - fee_in, 2), "won"
        elif final_mid is not None and final_mid <= 0.03:
            hold_pnl, resolved = round(-entry * shares - fee_in, 2), "lost"
        else:
            lb = s.bid[last_i] if last_i is not None else None
            hold_pnl = round((lb - entry) * shares - fee_in, 2) if lb is not None else None
            resolved = "unresolved (marked at last bid)"
        trades.append({**rec, "action": "buy", "entry_ts": iso(te), "entry_ask": entry,
                       "shares": round(shares, 2), "capped_by_top_size": capped, "fee_entry": round(fee_in, 3),
                       "exit_timed_ts": iso(te + a.hold), "exit_timed_bid": bid_x, "pnl_timed": timed,
                       "final_mid": final_mid, "hold_outcome": resolved, "pnl_hold": hold_pnl,
                       "last_data_ts": iso(s.ts[last_i]) if last_i is not None else None})
    with open(a.out, "w") as f:
        for t in trades:
            f.write(json.dumps(t) + "\n")
    buys = [t for t in trades if t["action"] == "buy"]
    print(f"signals {len(trades)}  buys {len(buys)}  skips {len(trades) - len(buys)}  typical move {typical:.3f}")
    for t in trades:
        if t["action"] == "buy":
            print(f"  BUY {t['side'][:16]:16s} @{t['entry_ask']:.3f} {t['signal_ts']}  timed({a.hold:.0f}s) "
                  f"pnl {t['pnl_timed']}  hold pnl {t['pnl_hold']} [{t['hold_outcome']}]")
        else:
            print(f"  skip {t['side'][:16]:16s} {t['signal_ts']}  {t['reason']}")
    tp = [t["pnl_timed"] for t in buys if t["pnl_timed"] is not None]
    if tp:
        print(f"timed-exit total ${sum(tp):.2f} over {len(tp)} trades (stake ${a.stake:.0f} each)")
    if len(buys) < 30:
        print("NOTE: far too few trades to say anything about edge.")
    print(f"wrote {len(trades)} rows -> {a.out}")


if __name__ == "__main__":
    main()
