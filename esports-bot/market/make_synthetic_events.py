#!/usr/bin/env python3
"""Generate a SYNTHETIC stream_events file from recorded prices, for testing align.py / paper_trade.py.

For every sharp move in the current-game market (>= --move within 30 s) it plants a
3-kill burst for the team the price moved toward, at (move onset + known lag). The
planted lag is stored in each row ("synthetic_lag_s") so align.py's output can be
checked: frac_before_stream should be high for positive lags, low for negative ones.

Writes data/synthetic/stream_events_synthetic.jsonl -- never the shared stream_events.jsonl.
"""
import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from align import load_prices  # noqa: E402
from common import DATA, iso  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", default=os.path.join(DATA, "prices.jsonl"))
    ap.add_argument("--match-map", default=os.path.join(DATA, "match_map.json"))
    ap.add_argument("--out", default=os.path.join(DATA, "synthetic", "stream_events_synthetic.jsonl"))
    ap.add_argument("--move", type=float, default=0.04)
    ap.add_argument("--lags", default="-20,-5,5,15,30", help="seconds after move onset the stream 'shows' it")
    ap.add_argument("--no-names", action="store_true", help="omit team names (test side inference)")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    random.seed(a.seed)
    lags = [float(x) for x in a.lags.split(",")]
    mm = json.load(open(a.match_map))
    series, games = load_prices(a.prices)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    rows = []
    for slug, g in games.items():
        ch = (mm.get(slug) or {}).get("twitch_channel")
        if not ch:
            continue
        outcomes = list(g[0][2])
        cg = g[-1][1]
        s = series.get((slug, "child_moneyline", cg, outcomes[0])) or series.get((slug, "moneyline", None, outcomes[0]))
        if s is None or not s.ts:
            continue
        t_start = s.ts[0]
        # find sharp moves
        moves, last_end = [], -1e18
        pts = [(t, m) for t, m in zip(s.ts, s.mid) if m is not None]
        j = 0
        for i, (t, m) in enumerate(pts):
            while pts[j][0] < t - 30:
                j += 1
            seg = pts[j:i + 1]
            lo = min(seg, key=lambda x: x[1])
            hi = max(seg, key=lambda x: x[1])
            if t > last_end and hi[1] - lo[1] >= a.move:
                up = hi[0] > lo[0]
                onset = lo[0] if up else hi[0]
                moves.append((onset, up))
                last_end = t + 60
        L = R = 0
        names = {} if a.no_names else {"left_team": outcomes[0], "right_team": outcomes[1]}
        t = t_start
        k = 0
        events = sorted([(on + lags[(idx) % len(lags)], up, lags[idx % len(lags)]) for idx, (on, up) in enumerate(moves)])
        ev_i = 0
        while t < s.ts[-1]:
            clock = t - t_start
            if ev_i < len(events) and events[ev_i][0] <= t:
                _, up, lag = events[ev_i]
                for n in range(3):  # 3 kills over ~6 s
                    if up:
                        L += 1
                    else:
                        R += 1
                    rows.append({"ts_utc": iso(t + 2 * n), "channel": ch, "game_clock": f"{int(clock + 2 * n) // 60}:{int(clock + 2 * n) % 60:02d}",
                                 "left_kills": L, "right_kills": R, **names, "event": "kill_change",
                                 "confidence": 0.9, "synthetic": True, "synthetic_lag_s": lag})
                ev_i += 1
                t += 6
                continue
            if random.random() < 1 / 90:  # background single kills
                if random.random() < 0.5:
                    L += 1
                else:
                    R += 1
                rows.append({"ts_utc": iso(t), "channel": ch, "game_clock": f"{int(clock) // 60}:{int(clock) % 60:02d}",
                             "left_kills": L, "right_kills": R, **names, "event": "kill_change",
                             "confidence": 0.9, "synthetic": True})
            elif k % 30 == 0:
                rows.append({"ts_utc": iso(t), "channel": ch, "game_clock": f"{int(clock) // 60}:{int(clock) % 60:02d}",
                             "left_kills": L, "right_kills": R, **names, "event": "heartbeat",
                             "confidence": 0.9, "synthetic": True})
            k += 1
            t += 1
        print(f"{slug} ({ch}): {len(moves)} sharp moves -> planted bursts")
    rows.sort(key=lambda r: r["ts_utc"])
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} synthetic rows -> {a.out}")


if __name__ == "__main__":
    main()
