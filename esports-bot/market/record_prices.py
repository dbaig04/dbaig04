#!/usr/bin/env python3
"""Record live Polymarket Dota 2 prices at ~1 s resolution.

- Discovers live Dota 2 events on Gamma every --discover-every seconds.
- Streams the CLOB market websocket (full book + trades) for every token of the
  match-winner and Game-N-winner markets of those events.
- Every second writes one row per token to data/prices.jsonl (best bid/ask with
  sizes, mid, last trade, staleness of the token's last update).
- Every websocket trade is also written to data/ws_trades.jsonl.
- Falls back to polling https://clob.polymarket.com/book every second while the
  websocket is down.
- Maps each event to its stream channel(s) via PandaScore -> data/match_map.json.

Research only. Never places orders.
"""
import argparse
import asyncio
import json
import os
import signal
import ssl
import sys
import time

import requests
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CA_BUNDLE, DATA, PSKEY_PATH, iso, name_score, now_iso, parse_ts  # noqa: E402

GAMMA = "https://gamma-api.polymarket.com/events"
BOOK = "https://clob.polymarket.com/book"
WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
PANDA = "https://api.pandascore.co/dota2/matches"

SESSION = requests.Session()
SESSION.verify = CA_BUNDLE if os.path.exists(CA_BUNDLE) else True
SESSION.headers.update({"Accept-Encoding": "gzip", "User-Agent": "research-recorder/0.1"})


def log(*a):
    print(now_iso(), *a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- discovery
def fetch_events():
    out, offset = [], 0
    while True:
        r = SESSION.get(GAMMA, params={"tag_slug": "dota-2", "closed": "false", "active": "true",
                                       "limit": 100, "offset": offset}, timeout=20)
        r.raise_for_status()
        page = r.json()
        out += page
        if len(page) < 100:
            return out
        offset += 100


def select_events(events, pre_start_min, max_age_h, only_slugs=None):
    now = time.time()
    sel = []
    for e in events:
        if only_slugs and e.get("slug") not in only_slugs:
            continue
        st = parse_ts(e.get("startTime")) if e.get("startTime") else None
        if st is None or e.get("ended"):
            continue
        is_live = bool(e.get("live"))
        in_window = (st - pre_start_min * 60) <= now <= (st + max_age_h * 3600)
        if is_live or in_window:
            sel.append(e)
    return sel


def current_game(e):
    p = e.get("period") or ""
    try:
        return int(p.split("/")[0])
    except (ValueError, IndexError):
        return None


def token_meta(events):
    meta = {}
    for e in events:
        for m in e.get("markets", []):
            mt = m.get("sportsMarketType")
            if mt not in ("moneyline", "child_moneyline") or m.get("closed"):
                continue
            try:
                toks = json.loads(m["clobTokenIds"])
                outs = json.loads(m["outcomes"])
            except Exception:
                continue
            game = None
            if mt == "child_moneyline":
                g = (m.get("groupItemTitle") or "").split()
                game = int(g[1]) if len(g) > 1 and g[1].isdigit() else None
            for i, (t, o) in enumerate(zip(toks, outs)):
                meta[t] = {
                    "event_slug": e["slug"], "condition_id": m.get("conditionId"),
                    "market_type": mt, "game": game, "title": m.get("groupItemTitle"),
                    "outcome": o, "outcome_index": i, "outcomes": outs,
                    "other_token": toks[1 - i] if len(toks) == 2 else None,
                }
    return meta


def pandascore_map(events, old):
    try:
        key = open(PSKEY_PATH).read().strip()
    except OSError:
        log("pandascore key not found; skipping match_map")
        return old
    try:
        r = SESSION.get(PANDA + "/running", headers={"Authorization": "Bearer " + key},
                        params={"per_page": 100}, timeout=20)
        r.raise_for_status()
        running = r.json()
        r2 = SESSION.get(PANDA + "/upcoming", headers={"Authorization": "Bearer " + key},
                         params={"per_page": 50, "sort": "scheduled_at"}, timeout=20)
        running += r2.json() if r2.ok else []
    except Exception as ex:  # noqa: BLE001
        log("pandascore error", type(ex).__name__)
        return old
    try:
        mm = dict(old) or json.load(open(os.path.join(DATA, "match_map.json")))
    except (OSError, ValueError):
        mm = {}
    for e in events:
        outs = None
        for m in e.get("markets", []):
            if m.get("sportsMarketType") == "moneyline":
                outs = json.loads(m["outcomes"])
        if not outs:
            continue
        best, best_s = None, 0.0
        for pm in running:
            opps = [o["opponent"] for o in pm.get("opponents", [])]
            if len(opps) != 2:
                continue
            s = 0.0
            for oname in outs:
                s += max(max(name_score(op["name"], oname), name_score(op.get("acronym") or "", oname,
                                                                       [op["name"]])) for op in opps)
            if s > best_s:
                best, best_s = pm, s
        if not best or best_s < 1.4:
            continue
        streams = [{"url": s.get("raw_url"), "main": s.get("main"), "language": s.get("language"),
                    "channel": (s.get("raw_url") or "").rstrip("/").split("/")[-1].lower()}
                   for s in best.get("streams_list", [])]
        main = [s for s in streams if s["main"]] or streams
        mm[e["slug"]] = {
            "event_slug": e["slug"], "title": e.get("title"), "start_time": e.get("startTime"),
            "outcomes": outs, "pandascore_match_id": best["id"], "pandascore_name": best.get("name"),
            "pandascore_status": best.get("status"),
            "teams": [{"name": o["opponent"]["name"], "acronym": o["opponent"].get("acronym"),
                       "outcome": max(outs, key=lambda x: name_score(o["opponent"]["name"], x))}
                      for o in best["opponents"]],
            "match_score": round(best_s, 2),
            "twitch_channel": next((s["channel"] for s in main if "twitch.tv" in (s["url"] or "")),
                                   main[0]["channel"] if main else None),
            "streams": streams, "updated": now_iso(),
        }
    with open(os.path.join(DATA, "match_map.json") + ".tmp", "w") as f:
        json.dump(mm, f, indent=1)
    os.replace(os.path.join(DATA, "match_map.json") + ".tmp", os.path.join(DATA, "match_map.json"))
    return mm


# ----------------------------------------------------------------------------- state
class Book:
    __slots__ = ("bids", "asks", "last", "last_ts", "last_side", "last_size", "upd", "src")

    def __init__(self):
        self.bids, self.asks = {}, {}
        self.last = self.last_ts = self.last_side = self.last_size = None
        self.upd = None
        self.src = None

    def snapshot(self, bids, asks, src):
        self.bids = {float(x["price"]): float(x["size"]) for x in bids if float(x["size"]) > 0}
        self.asks = {float(x["price"]): float(x["size"]) for x in asks if float(x["size"]) > 0}
        self.upd, self.src = time.time(), src

    def change(self, side, price, size):
        d = self.bids if side == "BUY" else self.asks
        p, s = float(price), float(size)
        if s <= 0:
            d.pop(p, None)
        else:
            d[p] = s
        self.upd, self.src = time.time(), "ws"

    def best(self):
        bb = max(self.bids) if self.bids else None
        ba = min(self.asks) if self.asks else None
        return bb, (self.bids[bb] if bb is not None else None), ba, (self.asks[ba] if ba is not None else None)


class Recorder:
    def __init__(self, args):
        self.args = args
        self.meta = {}
        self.events = {}
        self.books = {}
        self.ws_connected = False
        self.ws_tokens = set()
        self.resub = asyncio.Event()
        self.match_map = {}
        self.stop = False
        self.prices_f = open(os.path.join(DATA, args.out), "a")
        self.trades_f = open(os.path.join(DATA, "ws_trades.jsonl"), "a")
        self.stats = {"ws_msgs": 0, "rows": 0, "poll_ok": 0, "poll_err": 0, "reconnects": 0}

    async def discover_loop(self):
        last_ps = 0
        while not self.stop:
            try:
                evs = await asyncio.to_thread(fetch_events)
                sel = select_events(evs, self.args.pre_start_min, 8, set(self.args.slugs or []) or None)
                meta = token_meta(sel)
                self.events = {e["slug"]: e for e in sel}
                if set(meta) != set(self.meta):
                    log(f"tracking {len(sel)} events / {len(meta)} tokens:", ", ".join(sorted(self.events)))
                    self.meta = meta
                    for t in meta:
                        self.books.setdefault(t, Book())
                    self.resub.set()
                if time.time() - last_ps > self.args.pandascore_every:
                    mm = await asyncio.to_thread(pandascore_map, sel, self.match_map)
                    if set(mm) >= set(self.events):
                        last_ps = time.time()
                    else:  # an event is unmapped (or PandaScore failed): retry next discovery
                        last_ps = time.time() - self.args.pandascore_every + 60
                    self.match_map = mm
            except Exception as ex:  # noqa: BLE001
                log("discover error", type(ex).__name__, str(ex)[:200])
            await asyncio.sleep(self.args.discover_every if self.meta else 10)

    def handle(self, msg):
        items = msg if isinstance(msg, list) else [msg]
        for m in items:
            et = m.get("event_type")
            if et == "book" or ("bids" in m and "asks" in m and "asset_id" in m):
                b = self.books.get(m["asset_id"])
                if b is not None:
                    b.snapshot(m.get("bids", []), m.get("asks", []), "ws")
            elif et == "price_change" or "price_changes" in m:
                for pc in m.get("price_changes", []):
                    b = self.books.get(pc.get("asset_id"))
                    if b is not None:
                        b.change(pc["side"], pc["price"], pc["size"])
            elif et == "last_trade_price":
                b = self.books.get(m.get("asset_id"))
                if b is not None:
                    b.last, b.last_side, b.last_size = float(m["price"]), m.get("side"), float(m.get("size") or 0)
                    b.last_ts = parse_ts(m.get("timestamp")) or time.time()
                    md = self.meta.get(m["asset_id"], {})
                    self.trades_f.write(json.dumps({
                        "ts_utc": iso(b.last_ts), "recv_utc": now_iso(), "event_slug": md.get("event_slug"),
                        "market_type": md.get("market_type"), "game": md.get("game"),
                        "outcome": md.get("outcome"), "token": m["asset_id"], "price": b.last,
                        "size": b.last_size, "side": b.last_side}) + "\n")

    async def ws_loop(self):
        ctx = ssl.create_default_context(cafile=CA_BUNDLE) if os.path.exists(CA_BUNDLE) else None
        while not self.stop:
            toks = sorted(self.meta)
            if not toks:
                await asyncio.sleep(2)
                continue
            try:
                async with websockets.connect(WS_URL, ssl=ctx, ping_interval=None, max_size=2**24,
                                              open_timeout=20) as ws:
                    await ws.send(json.dumps({"assets_ids": toks, "type": "market"}))
                    self.ws_connected, self.ws_tokens = True, set(toks)
                    self.resub.clear()
                    log(f"ws connected, {len(toks)} tokens")
                    last_ping = time.time()
                    while not self.stop and not self.resub.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        except asyncio.TimeoutError:
                            raw = None
                        if time.time() - last_ping > 10:
                            await ws.send("PING")
                            last_ping = time.time()
                        if raw is None or raw in ("PONG", b"PONG"):
                            continue
                        self.stats["ws_msgs"] += 1
                        try:
                            self.handle(json.loads(raw))
                        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as ex:
                            log("ws parse issue", type(ex).__name__, str(raw)[:120])
            except Exception as ex:  # noqa: BLE001
                log("ws error", type(ex).__name__, str(ex)[:200])
            self.ws_connected = False
            self.stats["reconnects"] += 1
            await asyncio.sleep(1)

    def _poll_one(self, t, compare_only=False):
        try:
            r = SESSION.get(BOOK, params={"token_id": t}, timeout=5)
            r.raise_for_status()
            j = r.json()
            self.stats["poll_ok"] += 1
            if compare_only:
                # sanity check of the ws-maintained book; do not overwrite (REST may be older than ws deltas)
                bids = [float(x["price"]) for x in j.get("bids", []) if float(x["size"]) > 0]
                asks = [float(x["price"]) for x in j.get("asks", []) if float(x["size"]) > 0]
                bb, _, ba, _ = self.books[t].best()
                ok = (max(bids) if bids else None) == bb and (min(asks) if asks else None) == ba
                self.stats["resync_match" if ok else "resync_mismatch"] = \
                    self.stats.get("resync_match" if ok else "resync_mismatch", 0) + 1
                return
            self.books[t].snapshot(j.get("bids", []), j.get("asks", []), "poll")
        except Exception:  # noqa: BLE001
            self.stats["poll_err"] += 1

    async def poll_loop(self):
        """Fallback REST polling while the websocket is down; plus a slow periodic resync."""
        last_resync = time.time()
        while not self.stop:
            toks = list(self.meta)
            if not self.ws_connected:
                await asyncio.gather(*[asyncio.to_thread(self._poll_one, t) for t in toks[:60]])
            elif time.time() - last_resync > self.args.resync_every:
                last_resync = time.time()
                await asyncio.gather(*[asyncio.to_thread(self._poll_one, t, True) for t in toks[:60]])
            await asyncio.sleep(1)

    async def writer_loop(self):
        nxt = int(time.time()) + 1
        last_stat = time.time()
        while not self.stop:
            await asyncio.sleep(max(0, nxt - time.time()))
            nxt += 1
            ts = now_iso()
            now = time.time()
            for t, md in list(self.meta.items()):
                b = self.books.get(t)
                if b is None:
                    continue
                bb, bbs, ba, bas = b.best()
                ev = self.events.get(md["event_slug"], {})
                mid = round((bb + ba) / 2, 4) if bb is not None and ba is not None else None
                row = {
                    "ts_utc": ts, "event_slug": md["event_slug"], "market_type": md["market_type"],
                    "game": md["game"], "current_game": current_game(ev), "score": ev.get("score"),
                    "outcome": md["outcome"], "outcome_index": md["outcome_index"], "outcomes": md["outcomes"],
                    "token": t, "bid": bb, "bid_size": bbs, "ask": ba, "ask_size": bas, "mid": mid,
                    "last": b.last, "last_ts": iso(b.last_ts) if b.last_ts else None,
                    "age_ms": int((now - b.upd) * 1000) if b.upd else None,
                    "src": b.src if self.ws_connected or b.src == "poll" else "stale",
                }
                self.prices_f.write(json.dumps(row, separators=(",", ":")) + "\n")
                self.stats["rows"] += 1
            self.prices_f.flush()
            self.trades_f.flush()
            if now - last_stat > 300:
                log("stats", json.dumps(self.stats), "ws" if self.ws_connected else "NO-WS")
                last_stat = now
            if self.args.duration and now - self.t0 > self.args.duration:
                self.stop = True

    async def run(self):
        self.t0 = time.time()
        others = [asyncio.create_task(c) for c in (self.discover_loop(), self.ws_loop(), self.poll_loop())]
        try:
            await self.writer_loop()
        finally:
            for t in others:
                t.cancel()
            await asyncio.gather(*others, return_exceptions=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slugs", nargs="*", help="only these Gamma event slugs (default: all live Dota events)")
    ap.add_argument("--out", default="prices.jsonl", help="file name under data/")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = forever)")
    ap.add_argument("--discover-every", type=float, default=60)
    ap.add_argument("--pandascore-every", type=float, default=300)
    ap.add_argument("--resync-every", type=float, default=120, help="REST book resync period while ws is up")
    ap.add_argument("--pre-start-min", type=float, default=10, help="start tracking N min before startTime")
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    rec = Recorder(args)
    loop = asyncio.new_event_loop()

    def _stop(*_):
        rec.stop = True
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, _stop)
    try:
        loop.run_until_complete(rec.run())
    finally:
        rec.prices_f.close()
        rec.trades_f.close()
        log("stopped", json.dumps(rec.stats))


if __name__ == "__main__":
    main()
