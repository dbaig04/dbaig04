#!/usr/bin/env python3
"""Read a live Dota 2 Twitch broadcast and log scoreboard changes.

Pipeline:  Twitch HLS (own poller, keeps PROGRAM-DATE-TIME per segment)
           -> ffmpeg (decode, select ~N fps, crop top strip, showinfo for PTS)
           -> OCR of radiant kills / clock / dire kills (tesseract, digits only)
           -> debounce state machine -> JSONL events

Usage:
    python3 stream_reader/read_stream.py --channel esl_dota2 [--fps 2]
"""
import argparse
import datetime as dt
import json
import logging
import os
import queue
import re
import resource
import subprocess
import sys
import threading
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hls import HLSFetcher  # noqa: E402
from ocr import ScoreboardOCR  # noqa: E402
from signals import SignalTracker  # noqa: E402

FRAME_W, FRAME_H = 1440, 820  # top-left region of the 1080p frame fed to the readers

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
log = logging.getLogger("reader")


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def fmt_clock(s):
    if s is None:
        return None
    sign = "-" if s < 0 else ""
    s = abs(int(s))
    return f"{sign}{s // 60}:{s % 60:02d}"


class Tracker:
    """Debounce/validation state machine.

    Rules (false events are worse than late ones):
      * a reading is only *usable* if clock, left and right kills all parsed
      * clock must be consistent with the confirmed clock advanced by elapsed
        stream time (+-4 s, pauses allowed = clock may stand still); readings
        with the clock far behind are treated as replays and ignored
      * kills are monotonic within a game; a new candidate (l, r) must be seen
        on `confirm` consecutive usable frames; big jumps (> 6 total) need 2x
      * first lock-on / new game (clock reset below 1:30 with low kills) needs
        4 consecutive consistent frames and emits clock_start
      * HUD missing for > 20 s after 10:00 game time -> game_end_suspect (once)
    """

    def __init__(self, confirm=2):
        self.confirm = confirm
        self.locked = False
        self.L = self.R = None
        self.clock = None          # confirmed clock (s)
        self.clock_t = None        # stream time (pdt) of confirmed clock
        self.cand = None
        self.cand_n = 0
        self.cand_clock_hist = []
        self.last_usable_t = None
        self.end_flagged = False
        self.paused_since = None

    def expected_clock(self, t):
        if self.clock is None:
            return None
        return self.clock + (t - self.clock_t)

    def update(self, t, l, r, c):
        """t: stream time (pdt or wall). Returns list of (event, confidence)."""
        events = []
        usable = l is not None and r is not None and c is not None
        if not usable:
            if (self.locked and not self.end_flagged and self.last_usable_t is not None
                    and t - self.last_usable_t > 20 and (self.clock or 0) > 600):
                self.end_flagged = True
                events.append(("game_end_suspect", 0.5))
            self.cand, self.cand_n = None, 0
            return events

        if not self.locked:
            key = (l, r)
            # require consistent kills and a clock advancing like real time
            if self.cand == key and self.cand_clock_hist and \
                    -1 <= c - self.cand_clock_hist[-1][1] - (t - self.cand_clock_hist[-1][0]) <= 1.5:
                self.cand_n += 1
            else:
                self.cand, self.cand_n = key, 1
                self.cand_clock_hist = []
            self.cand_clock_hist.append((t, c))
            if self.cand_n >= 4:
                self._lock(t, l, r, c)
                events.append(("clock_start", 0.8))
            return events

        exp = self.expected_clock(t)
        diff = c - exp
        if diff > 4 or diff < -(t - self.clock_t) - 4:
            # clock jumped forward (misread) or went backwards (replay/new game)
            if c < 90 and l + r <= 2:
                # possible new game: needs fresh lock-on
                self.locked = False
                self.cand, self.cand_n, self.cand_clock_hist = (l, r), 1, [(t, c)]
                log.info("clock reset to %s, re-locking (new game?)", fmt_clock(c))
            else:
                self.cand, self.cand_n = None, 0
            return events
        # clock consistent (allowing pause)
        self.clock, self.clock_t = c, t
        self.last_usable_t = t
        if self.end_flagged:
            self.end_flagged = False

        if (l, r) == (self.L, self.R):
            self.cand, self.cand_n = None, 0
            return events
        if l < self.L or r < self.R:
            # kills decreased: OCR noise (or replay that kept clock) -> ignore
            self.cand, self.cand_n = None, 0
            return events
        key = (l, r)
        if self.cand == key:
            self.cand_n += 1
        else:
            self.cand, self.cand_n = key, 1
        need = self.confirm if (l - self.L) + (r - self.R) <= 6 else self.confirm * 2
        if self.cand_n >= need:
            self.L, self.R = l, r
            self.cand, self.cand_n = None, 0
            events.append(("kill_change", min(1.0, 0.75 + 0.1 * need)))
        return events

    def _lock(self, t, l, r, c):
        self.locked = True
        self.L, self.R = l, r
        self.clock, self.clock_t = c, t
        self.last_usable_t = t
        self.cand, self.cand_n = None, 0
        self.end_flagged = False


LOGO_BOXES = {"left": (472, 0, 540, 44), "right": (1372, 0, 1440, 44)}


def logo_crop(frame, side):
    x0, y0, x1, y1 = LOGO_BOXES[side]
    return cv2.cvtColor(np.ascontiguousarray(frame[y0:y1, x0:x1]), cv2.COLOR_BGR2GRAY)


def logo_sim(a, b):
    if a is None or b is None or a.shape != b.shape:
        return -1.0
    return float(cv2.matchTemplate(a.astype(np.float32), b.astype(np.float32), cv2.TM_CCOEFF_NORMED)[0, 0])


class SideKeeper:
    """Keeps left/right team names correct across games: the top-bar logo
    crops of each team are stored (data/logos/) the first time a game is
    locked with known names; at each later clock_start the current logos are
    compared with the stored ones and the names are swapped if the teams
    switched sides."""

    def __init__(self, channel, left, right):
        self.dir = os.path.join(DATA, "logos")
        os.makedirs(self.dir, exist_ok=True)
        self.channel = channel
        self.teams = [left, right]
        self.ref = {}
        for t in (left, right):
            if t:
                im = cv2.imread(self._path(t), cv2.IMREAD_GRAYSCALE)
                if im is not None:
                    self.ref[t] = im

    def _path(self, team):
        return os.path.join(self.dir, f"{self.channel}_{re.sub(r'[^A-Za-z0-9]+', '_', team)}.png")

    def on_lock(self, frame):
        """Returns True if sides were swapped."""
        L, R = self.teams
        if not (L and R):
            return False
        cl, cr = logo_crop(frame, "left"), logo_crop(frame, "right")
        swapped = False
        if L in self.ref and R in self.ref:
            same = logo_sim(cl, self.ref[L]) + logo_sim(cr, self.ref[R])
            swap = logo_sim(cl, self.ref[R]) + logo_sim(cr, self.ref[L])
            log.info("logo check same=%.2f swap=%.2f", same, swap)
            if swap > same + 0.3:
                self.teams = [R, L]
                swapped = True
        L, R = self.teams
        for t, im in ((L, cl), (R, cr)):
            if t not in self.ref:
                self.ref[t] = im
                cv2.imwrite(self._path(t), im)
        return swapped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", required=True)
    ap.add_argument("--fps", type=float, default=4.0)
    ap.add_argument("--quality", default="best", help="Twitch quality (best=1080p60 source); falls back to 720p60/720p")
    ap.add_argument("--out", default=os.path.join(DATA, "stream_events.jsonl"))
    ap.add_argument("--debug-dir", default=os.path.join(DATA, "debug"))
    ap.add_argument("--debug-every", type=float, default=120, help="save a strip every N s")
    ap.add_argument("--confirm", type=int, default=2, help="consecutive frames to confirm a change")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = forever)")
    ap.add_argument("--left-team", default=None, help="name/tag of the Radiant (left) team")
    ap.add_argument("--right-team", default=None, help="name/tag of the Dire (right) team")
    ap.add_argument("--ocr-teams", action="store_true", help="best-effort OCR of team names (unreliable)")
    ap.add_argument("--no-feed-log", dest="feed_log", action="store_false",
                    help="do not write OCR'd kill-feed lines to data/feed_<channel>.log")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if args.verbose:
        log.setLevel(logging.DEBUG)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    os.makedirs(args.debug_dir, exist_ok=True)
    out = open(args.out, "a", buffering=1)

    stop = threading.Event()
    interval = max(0.05, 1.0 / args.fps - 0.01)
    vf = (f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{interval:.3f})',"
          f"crop=iw*0.75:ih*{FRAME_H / 1080:.4f}:0:0,scale={FRAME_W}:{FRAME_H},showinfo")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-nostats",
           "-fflags", "nobuffer", "-copyts", "-f", "mpegts", "-i", "pipe:0",
           "-an", "-vf", vf, "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          bufsize=0)
    fetcher = HLSFetcher(args.channel, args.quality, ff.stdin, stop)
    fetcher.start()

    pts_q = queue.Queue()
    pts_re = re.compile(rb"pts_time:\s*([-0-9.]+)")

    def stderr_reader():
        for line in ff.stderr:
            if b"showinfo" in line and b"pts_time" in line:
                m = pts_re.search(line)
                if m:
                    pts_q.put(float(m.group(1)))
            elif b"rror" in line:
                log.debug("ffmpeg: %s", line.decode(errors="replace").strip())
    threading.Thread(target=stderr_reader, daemon=True).start()

    ocr = ScoreboardOCR()
    tr = Tracker(confirm=args.confirm)
    frame_bytes = FRAME_W * FRAME_H * 3
    sig = SignalTracker(feed_log=os.path.join(DATA, f"feed_{args.channel}.log") if args.feed_log else None,
                        debug_dir=args.debug_dir, tag=args.channel)
    t_start = time.time()
    last_hb = 0
    last_dbg = 0
    n_frames = 0
    n_usable = 0
    lat_hist = []
    ocr_ms = []
    sides = SideKeeper(args.channel, args.left_team, args.right_team)
    teams = tuple(sides.teams)
    last_team_t = 0
    last_read = None
    cpu0 = resource.getrusage(resource.RUSAGE_SELF)
    cpu0c = resource.getrusage(resource.RUSAGE_CHILDREN)

    def emit(rec):
        out.write(json.dumps(rec) + "\n")

    try:
        while not stop.is_set():
            if args.duration and time.time() - t_start > args.duration:
                break
            buf = b""
            while len(buf) < frame_bytes:
                chunk = ff.stdout.read(frame_bytes - len(buf))
                if not chunk:
                    raise RuntimeError("ffmpeg exited")
                buf += chunk
            recv = time.time()
            try:
                pts = pts_q.get(timeout=2)
            except queue.Empty:
                pts = None
            pdt = fetcher.pts_to_pdt(pts) if pts is not None else None
            if pdt is not None:
                lat_hist.append(recv - pdt)
                lat_hist = lat_hist[-240:]
            frame = np.frombuffer(buf, np.uint8).reshape(FRAME_H, FRAME_W, 3)
            img = frame[0:81]  # top strip
            n_frames += 1
            t0 = time.time()
            l, r, c, raw = ocr.read(img)
            if args.ocr_teams and time.time() - last_team_t > 60 and c is not None:
                teams = ocr.read_teams(img)
                last_team_t = time.time()
            ocr_ms.append((time.time() - t0) * 1000)
            ocr_ms = ocr_ms[-240:]
            if c is not None and l is not None and r is not None:
                n_usable += 1
            last_read = (l, r, c)
            log.debug("frame pts=%s lat=%s read=%s raw=%s", pts,
                      None if pdt is None else round(recv - pdt, 2), last_read, raw)
            tstream = pdt if pdt is not None else recv
            evs = [(ev, conf, {}) for ev, conf in tr.update(tstream, l, r, c)]
            if any(e[0] == "clock_start" for e in evs):
                if sides.on_lock(frame):
                    log.info("teams switched sides: left=%s right=%s", *sides.teams)
                    evs = [(e, cf, {"sides_swapped": True} if e == "clock_start" else x) for e, cf, x in evs]
                teams = tuple(sides.teams)
            hud_ok = tr.locked and c is not None and l is not None and r is not None and \
                tr.clock is not None and abs(c - tr.clock) <= 1
            evs += sig.update(frame, tstream, hud_ok, tr.clock)
            for ev, conf, extra in evs:
                rec = {"ts_utc": iso(recv), "channel": args.channel,
                       "game_clock": fmt_clock(tr.clock),
                       "left_kills": tr.L, "right_kills": tr.R,
                       "left_team": teams[0], "right_team": teams[1],
                       "event": ev, "confidence": round(conf, 2),
                       "gold_lead": sig.gold_lead,
                       "stream_pdt_utc": iso(pdt) if pdt else None,
                       "latency_s": round(recv - pdt, 2) if pdt else None}
                rec.update(extra)
                emit(rec)
                log.info("EVENT %s", rec)
                fn = os.path.join(args.debug_dir, f"{args.channel}_{ev}_{recv:.0f}_{tr.L}-{tr.R}_{fmt_clock(tr.clock)}.png".replace(":", "m"))
                cv2.imwrite(fn, ocr.annotate(img) if ev in ("kill_change", "clock_start", "game_end_suspect")
                            else frame)
            if recv - last_dbg > args.debug_every:
                last_dbg = recv
                cv2.imwrite(os.path.join(args.debug_dir, f"{args.channel}_strip_{recv:.0f}.png"), ocr.annotate(img))
            if recv - last_hb > 30:
                last_hb = recv
                cpu1 = resource.getrusage(resource.RUSAGE_SELF)
                el = recv - t_start
                cpu1c = resource.getrusage(resource.RUSAGE_CHILDREN)  # reaped tesseract runs
                cpu_py = (cpu1.ru_utime + cpu1.ru_stime - cpu0.ru_utime - cpu0.ru_stime
                          + cpu1c.ru_utime + cpu1c.ru_stime - cpu0c.ru_utime - cpu0c.ru_stime) / max(el, 1)
                try:  # ffmpeg CPU (still running, so read /proc)
                    st = open(f"/proc/{ff.pid}/stat").read().split()
                    cpu_ff = (int(st[13]) + int(st[14])) / os.sysconf("SC_CLK_TCK") / max(el, 1)
                except Exception:
                    cpu_ff = None
                ls = sorted(lat_hist)
                rec = {"ts_utc": iso(recv), "channel": args.channel, "event": "heartbeat",
                       "game_clock": fmt_clock(tr.clock), "left_kills": tr.L, "right_kills": tr.R,
                       "gold_lead": sig.gold_lead, "left_team": teams[0], "right_team": teams[1], "confidence": None,
                       "locked": tr.locked, "last_read": last_read,
                       "frames": n_frames, "usable_frames": n_usable,
                       "latency_s_median": round(ls[len(ls) // 2], 2) if ls else None,
                       "latency_s_max": round(ls[-1], 2) if ls else None,
                       "playlist_lag_s": round(fetcher.playlist_lag, 2) if fetcher.playlist_lag else None,
                       "ocr_ms_median": round(sorted(ocr_ms)[len(ocr_ms) // 2], 1) if ocr_ms else None,
                       "cpu_cores_python_ocr": round(cpu_py, 3),
                       "cpu_cores_ffmpeg": round(cpu_ff, 3) if cpu_ff is not None else None,
                       "ad_segments_skipped": fetcher.ad_segments}
                emit(rec)
                log.info("heartbeat %s", rec)
    finally:
        stop.set()
        try:
            ff.kill()
        except Exception:
            pass
        if fetcher.error:
            log.error("fetcher error: %s", fetcher.error)


if __name__ == "__main__":
    main()
