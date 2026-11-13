#!/usr/bin/env python3
"""Join stream events (data/stream_events.jsonl) to recorded Polymarket prices.

For each "big stream event" (default: >=3 kills to one side within 20 s of game
clock, net swing >=2) report the favoured team's mid at -60/-30/-10/0/+10/+30/+60 s
around the moment the stream reader saw it, and what fraction of the eventual
move (-60 -> +60) had already happened at t0.

Output: data/aligned_events.jsonl + a summary on stdout.
"""
import argparse
import bisect
import json
import os
import re
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, iso, name_score, parse_ts, read_jsonl  # noqa: E402

OFFSETS = (-60, -30, -10, 0, 10, 30, 60)


# ----------------------------------------------------------------------------- prices
class Series:
    """As-of lookup on a per-token 1 s price series."""

    def __init__(self):
        self.ts, self.bid, self.ask, self.mid = [], [], [], []

    def add(self, t, bid, ask, mid):
        self.ts.append(t)
        self.bid.append(bid)
        self.ask.append(ask)
        self.mid.append(mid)

    def finish(self):
        order = sorted(range(len(self.ts)), key=self.ts.__getitem__)
        for name in ("ts", "bid", "ask", "mid"):
            arr = getattr(self, name)
            setattr(self, name, [arr[i] for i in order])

    def at(self, t, field="mid", max_stale=5.0):
        i = bisect.bisect_right(self.ts, t) - 1
        if i < 0 or t - self.ts[i] > max_stale:
            return None
        return getattr(self, field)[i]

    def window(self, t0, t1, field="mid"):
        i, j = bisect.bisect_left(self.ts, t0), bisect.bisect_right(self.ts, t1)
        arr = getattr(self, field)
        return [(self.ts[k], arr[k]) for k in range(i, j) if arr[k] is not None]


def load_prices(path, slugs=None):
    """Returns {(slug, market_type, game, outcome): Series}, {slug: [(ts, current_game, outcomes)]}."""
    series = defaultdict(Series)
    games = defaultdict(list)
    with open(path) as f:
        for line in f:
            if slugs and not any(s in line for s in slugs):
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("src") == "stale":
                continue
            t = parse_ts(r["ts_utc"])
            bid, ask = r.get("bid"), r.get("ask")
            mid = r.get("mid")
            # a one-sided / 1c-99c book carries no information
            if bid is None or ask is None or ask - bid > 0.2:
                mid = None
            series[(r["event_slug"], r["market_type"], r.get("game"), r["outcome"])].add(t, bid, ask, mid)
            if r["outcome_index"] == 0 and r["market_type"] == "moneyline":
                games[r["event_slug"]].append((t, r.get("current_game"), tuple(r["outcomes"])))
    for s in series.values():
        s.finish()
    for g in games.values():
        g.sort()
    return series, games


# ----------------------------------------------------------------------------- stream
def parse_clock(c):
    if c is None:
        return None
    if isinstance(c, (int, float)):
        return float(c)
    m = re.fullmatch(r"\s*(-?)(\d+):(\d{2})(?::(\d{2}))?\s*", str(c))
    if not m:
        try:
            return float(c)
        except ValueError:
            return None
    sign = -1 if m.group(1) else 1
    if m.group(4) is not None:
        return sign * (int(m.group(2)) * 3600 + int(m.group(3)) * 60 + int(m.group(4)))
    return sign * (int(m.group(2)) * 60 + int(m.group(3)))


def segment_games(rows):
    """Split a channel's rows into games: new game on clock_start, a clock reset or kills dropping."""
    segs, cur, last = [], [], None
    for r in rows:
        new = False
        if last is not None:
            if r.get("event") == "clock_start" and cur:
                new = True
            elif r["clock"] is not None and last["clock"] is not None and r["clock"] < last["clock"] - 120:
                new = True
            elif (r["L"] is not None and last["L"] is not None and
                  (r["L"] + 3 < last["L"] or r["R"] + 3 < last["R"])):
                new = True
            elif r["t"] - last["t"] > 900:
                new = True
        if new and cur:
            segs.append(cur)
            cur = []
        cur.append(r)
        if r["L"] is not None:
            last = r
        elif last is None:
            last = r
    if cur:
        segs.append(cur)
    return segs


def load_stream(path, min_conf):
    by_ch = defaultdict(list)
    for r in read_jsonl(path):
        if r.get("ts_utc") is None:
            continue
        conf = r.get("confidence")
        if conf is not None and conf < min_conf and r.get("event") == "kill_change":
            continue
        L, R = r.get("left_kills"), r.get("right_kills")
        by_ch[(r.get("channel") or "").lower()].append({
            "t": parse_ts(r["ts_utc"]), "clock": parse_clock(r.get("game_clock")),
            "L": L if isinstance(L, (int, float)) else None, "R": R if isinstance(R, (int, float)) else None,
            "left_team": r.get("left_team"), "right_team": r.get("right_team"),
            "event": r.get("event"), "conf": conf, "raw": r})
    for v in by_ch.values():
        v.sort(key=lambda x: x["t"])
    return by_ch


def detect_big(seg, kills=3, window=20.0, net=2, cooldown=30.0):
    """Return [(row, side 'L'|'R', dL, dR)] where one side got >=kills within `window` s of game clock."""
    rows = [r for r in seg if r["L"] is not None and r["R"] is not None]
    out, block_until, j = [], None, 0
    for i, r in enumerate(rows):
        clk = r["clock"] if r["clock"] is not None else r["t"]
        if block_until is not None and clk < block_until:
            continue
        # earliest row within window
        while j < i:
            cj = rows[j]["clock"] if rows[j]["clock"] is not None else rows[j]["t"]
            if clk - cj > window:
                j += 1
            else:
                break
        base = rows[j - 1] if j > 0 else rows[0]  # last state before the window
        dL, dR = r["L"] - base["L"], r["R"] - base["R"]
        if max(dL, dR) >= kills and abs(dL - dR) >= net:
            out.append((r, "L" if dL > dR else "R", dL, dR))
            block_until = clk + cooldown
            j = i
    return out


# ----------------------------------------------------------------------------- mapping
def channel_to_slug(channel, t, match_map, games, overrides):
    if channel in overrides:
        return overrides[channel]
    cands = []
    for slug, m in match_map.items():
        chans = {(m.get("twitch_channel") or "").lower()} | {(s.get("channel") or "").lower()
                                                             for s in m.get("streams", [])}
        if channel in chans and slug in games:
            g = games[slug]
            if g and g[0][0] - 300 <= t <= g[-1][0] + 300:
                cands.append(slug)
    return cands[0] if len(cands) == 1 else (cands[0] if cands else None)


def current_game_at(games, slug, t):
    g = games.get(slug) or []
    i = bisect.bisect_right([x[0] for x in g], t) - 1
    return g[i][1] if i >= 0 else None


def pick_series(series, slug, game, outcome):
    s = series.get((slug, "child_moneyline", game, outcome))
    if s is not None and any(m is not None for m in s.mid):
        return s, "child_moneyline", game
    return series.get((slug, "moneyline", None, outcome)), "moneyline", None


def map_sides(seg, outcomes, aliases, series, slug, game):
    """Return ({'L': outcome, 'R': outcome}, method, confidence 0..1, note)."""
    lt = next((r["left_team"] for r in seg if r.get("left_team")), None)
    rt = next((r["right_team"] for r in seg if r.get("right_team")), None)
    if lt and rt:
        sc = {}
        for side, nm in (("L", lt), ("R", rt)):
            sc[side] = {o: name_score(nm, o, aliases.get(o, ())) for o in outcomes}
        a = (sc["L"][outcomes[0]] + sc["R"][outcomes[1]])
        b = (sc["L"][outcomes[1]] + sc["R"][outcomes[0]])
        if max(a, b) >= 1.2 and abs(a - b) >= 0.4:
            return ({"L": outcomes[0], "R": outcomes[1]} if a > b else {"L": outcomes[1], "R": outcomes[0]},
                    "team_names", min(1.0, abs(a - b) / 1.0), f"HUD names {lt!r}/{rt!r}")
    # infer: kill-diff changes vs price changes of outcome[0]
    s, _, _ = pick_series(series, slug, game, outcomes[0])
    votes, n = 0.0, 0
    rows = [r for r in seg if r["L"] is not None]
    for a, b in zip(rows, rows[1:]):
        dd = (b["L"] - b["R"]) - (a["L"] - a["R"])
        if dd == 0 or s is None:
            continue
        m0, m1 = s.at(b["t"] - 15), s.at(b["t"] + 30)
        if m0 is None or m1 is None or abs(m1 - m0) < 0.005:
            continue
        votes += (1 if (dd > 0) == (m1 > m0) else -1) * min(abs(m1 - m0), 0.1)
        n += 1
    if n == 0:
        return {"L": outcomes[0], "R": outcomes[1]}, "default_guess", 0.0, "no names, no informative price moves"
    mapping = {"L": outcomes[0], "R": outcomes[1]} if votes > 0 else {"L": outcomes[1], "R": outcomes[0]}
    tot = sum(1 for _ in range(n))
    return mapping, "price_inference", min(1.0, abs(votes) / (0.02 * tot + 1e-9)) * min(1.0, n / 8), \
        f"{n} kill changes, weighted vote {votes:+.3f}"


# ----------------------------------------------------------------------------- main analysis
def analyse(stream_path, prices_path, match_map_path, overrides=None, kills=3, window=20.0, net=2,
            min_conf=0.5, slugs=None):
    overrides = overrides or {}
    match_map = json.load(open(match_map_path)) if os.path.exists(match_map_path) else {}
    stream = load_stream(stream_path, min_conf)
    want = set(slugs or []) | set(overrides.values())
    if not want:
        want = {s for s, m in match_map.items()
                if any(ch in stream for ch in [(m.get("twitch_channel") or "").lower()] +
                       [(x.get("channel") or "").lower() for x in m.get("streams", [])])}
    series, games = load_prices(prices_path, want or None)
    results, notes = [], []
    for ch, rows in stream.items():
        for gi, seg in enumerate(segment_games(rows)):
            t_mid = seg[len(seg) // 2]["t"]
            slug = channel_to_slug(ch, t_mid, match_map, games, overrides)
            if not slug:
                notes.append(f"channel {ch} segment {gi}: no matching market with price data")
                continue
            outcomes = list(games[slug][0][2])
            aliases = {}
            for tm in match_map.get(slug, {}).get("teams", []):
                aliases.setdefault(tm["outcome"], []).extend([tm["name"], tm.get("acronym") or ""])
            game = current_game_at(games, slug, t_mid)
            sides, method, conf, note = map_sides(seg, outcomes, aliases, series, slug, game)
            notes.append(f"{ch} seg{gi} -> {slug} game {game}: L={sides['L']} R={sides['R']} via {method} "
                         f"(conf {conf:.2f}; {note})")
            for r, side, dL, dR in detect_big(seg, kills, window, net):
                fav = sides[side]
                g_now = current_game_at(games, slug, r["t"]) or game
                s, mtype, mgame = pick_series(series, slug, g_now, fav)
                if s is None:
                    continue
                t0 = r["t"]
                mids = {o: s.at(t0 + o) for o in OFFSETS}
                pre = tot = frac = onset = None
                if mids[-60] is not None and mids[60] is not None and mids[0] is not None:
                    pre, tot = mids[0] - mids[-60], mids[60] - mids[-60]
                    if abs(tot) >= 0.02:
                        frac = pre / tot
                        half = mids[-60] + tot / 2
                        for ts, m in s.window(t0 - 60, t0 + 60):
                            if (tot > 0 and m >= half) or (tot < 0 and m <= half):
                                onset = round(ts - t0, 1)
                                break
                results.append({
                    "ts_utc": iso(t0), "channel": ch, "event_slug": slug, "market_type": mtype, "game": mgame,
                    "game_clock": r["raw"].get("game_clock"), "favoured_side": side, "favoured": fav,
                    "kills_window": {"left": dL, "right": dR}, "score": [r["L"], r["R"]],
                    "side_map_method": method, "side_map_conf": round(conf, 2),
                    "stream_conf": r["conf"],
                    **{f"mid_{o:+d}": mids[o] for o in OFFSETS},
                    "ask_0": s.at(t0, "ask"), "bid_0": s.at(t0, "bid"),
                    "ask_-60": s.at(t0 - 60, "ask"),
                    "pre_move": round(pre, 4) if pre is not None else None,
                    "total_move": round(tot, 4) if tot is not None else None,
                    "frac_before_stream": round(frac, 3) if frac is not None else None,
                    "half_move_at_s": onset,
                })
    return results, notes


def summarise(results):
    lines = []
    valid = [r for r in results if r["frac_before_stream"] is not None]
    right_dir = [r for r in valid if r["total_move"] > 0]
    lines.append(f"big stream events: {len(results)}; with full -60..+60 price window and |move|>=2c: "
                 f"{len(valid)}; of those, price moved toward the favoured team: {len(right_dir)}")
    if right_dir:
        fr = [r["frac_before_stream"] for r in right_dir]
        on = [r["half_move_at_s"] for r in right_dir if r["half_move_at_s"] is not None]
        lines.append(f"  median fraction of (-60..+60) move already done at stream time: {statistics.median(fr):.2f}"
                     f"  (>50% pre-moved in {sum(f > 0.5 for f in fr)}/{len(fr)})")
        if on:
            lines.append(f"  median time the move reached 50% relative to stream event: {statistics.median(on):+.1f}s")
        lines.append(f"  median total move: {statistics.median(r['total_move'] for r in right_dir):.3f}")
    if len(right_dir) < 20:
        lines.append("  NOTE: too few events to conclude anything.")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stream", default=os.path.join(DATA, "stream_events.jsonl"))
    ap.add_argument("--prices", default=os.path.join(DATA, "prices.jsonl"))
    ap.add_argument("--match-map", default=os.path.join(DATA, "match_map.json"))
    ap.add_argument("--out", default=os.path.join(DATA, "aligned_events.jsonl"))
    ap.add_argument("--map", action="append", default=[], help="override channel=event_slug")
    ap.add_argument("--kills", type=int, default=3)
    ap.add_argument("--window", type=float, default=20.0, help="game-clock seconds")
    ap.add_argument("--net", type=int, default=2)
    ap.add_argument("--min-conf", type=float, default=0.5)
    a = ap.parse_args()
    ov = dict(x.split("=", 1) for x in a.map)
    ov = {k.lower(): v for k, v in ov.items()}
    res, notes = analyse(a.stream, a.prices, a.match_map, ov, a.kills, a.window, a.net, a.min_conf)
    with open(a.out, "w") as f:
        for r in res:
            f.write(json.dumps(r) + "\n")
    for n in notes:
        print("#", n)
    hdr = "ts_utc                    channel        fav             " + " ".join(f"{o:+4d}" for o in OFFSETS) + "  frac  half@"
    print(hdr)
    for r in res:
        mids = " ".join(f"{r[f'mid_{o:+d}']:.2f}" if r[f"mid_{o:+d}"] is not None else "  - " for o in OFFSETS)
        fr = f"{r['frac_before_stream']:.2f}" if r["frac_before_stream"] is not None else "  - "
        print(f"{r['ts_utc']}  {r['channel'][:13]:13s}  {r['favoured'][:14]:14s}  {mids}  {fr}  {r['half_move_at_s']}")
    print(summarise(res))
    print(f"wrote {len(res)} rows -> {a.out}")


if __name__ == "__main__":
    main()
