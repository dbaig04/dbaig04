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
from ocr import ScoreboardOCR, STRIP_W, STRIP_H, STRIP_FRAC  # noqa: E402

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", required=True)
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--quality", default="720p60", help="Twitch quality; falls back to 720p/best")
    ap.add_argument("--out", default=os.path.join(DATA, "stream_events.jsonl"))
    ap.add_argument("--debug-dir", default=os.path.join(DATA, "debug"))
    ap.add_argument("--debug-every", type=float, default=120, help="save a strip every N s")
    ap.add_argument("--confirm", type=int, default=2, help="consecutive frames to confirm a change")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = forever)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    os.makedirs(args.debug_dir, exist_ok=True)
    out = open(args.out, "a", buffering=1)

    stop = threading.Event()
    interval = max(0.05, 1.0 / args.fps - 0.01)
    vf = (f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{interval:.3f})',"
          f"crop=iw:ih*{STRIP_FRAC}:0:0,scale={STRIP_W}:{STRIP_H},showinfo")
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
    frame_bytes = STRIP_W * STRIP_H * 3
    t_start = time.time()
    last_hb = 0
    last_dbg = 0
    n_frames = 0
    n_usable = 0
    lat_hist = []
    ocr_ms = []
    teams = (None, None)
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
            img = np.frombuffer(buf, np.uint8).reshape(STRIP_H, STRIP_W, 3)
            n_frames += 1
            t0 = time.time()
            l, r, c, raw = ocr.read(img)
            if time.time() - last_team_t > 60 and c is not None:
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
            for ev, conf in tr.update(tstream, l, r, c):
                rec = {"ts_utc": iso(recv), "channel": args.channel,
                       "game_clock": fmt_clock(tr.clock),
                       "left_kills": tr.L, "right_kills": tr.R,
                       "left_team": teams[0], "right_team": teams[1],
                       "event": ev, "confidence": round(conf, 2),
                       "stream_pdt_utc": iso(pdt) if pdt else None,
                       "latency_s": round(recv - pdt, 2) if pdt else None}
                emit(rec)
                log.info("EVENT %s", rec)
                fn = os.path.join(args.debug_dir, f"{args.channel}_{ev}_{recv:.0f}_{tr.L}-{tr.R}_{fmt_clock(tr.clock)}.png".replace(":", "m"))
                cv2.imwrite(fn, ocr.annotate(img))
            if recv - last_dbg > args.debug_every:
                last_dbg = recv
                cv2.imwrite(os.path.join(args.debug_dir, f"{args.channel}_strip_{recv:.0f}.png"), ocr.annotate(img))
            if recv - last_hb > 30:
                last_hb = recv
                cpu1 = resource.getrusage(resource.RUSAGE_SELF)
                el = recv - t_start
                cpu_py = (cpu1.ru_utime + cpu1.ru_stime - cpu0.ru_utime - cpu0.ru_stime) / max(el, 1)
                try:  # ffmpeg CPU (still running, so read /proc)
                    st = open(f"/proc/{ff.pid}/stat").read().split()
                    cpu_ff = (int(st[13]) + int(st[14])) / os.sysconf("SC_CLK_TCK") / max(el, 1)
                except Exception:
                    cpu_ff = None
                ls = sorted(lat_hist)
                rec = {"ts_utc": iso(recv), "channel": args.channel, "event": "heartbeat",
                       "game_clock": fmt_clock(tr.clock), "left_kills": tr.L, "right_kills": tr.R,
                       "left_team": teams[0], "right_team": teams[1], "confidence": None,
                       "locked": tr.locked, "last_read": last_read,
                       "frames": n_frames, "usable_frames": n_usable,
                       "latency_s_median": round(ls[len(ls) // 2], 2) if ls else None,
                       "latency_s_max": round(ls[-1], 2) if ls else None,
                       "playlist_lag_s": round(fetcher.playlist_lag, 2) if fetcher.playlist_lag else None,
                       "ocr_ms_median": round(sorted(ocr_ms)[len(ocr_ms) // 2], 1) if ocr_ms else None,
                       "cpu_cores_python": round(cpu_py, 3),
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
