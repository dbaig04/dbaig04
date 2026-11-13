"""Minimal Twitch HLS fetcher that keeps EXT-X-PROGRAM-DATE-TIME per segment.

We do our own HLS polling (instead of `streamlink | ffmpeg`) so every decoded
frame can be mapped back to the Twitch ingest wall-clock time of that frame
(segment PDT + offset inside the segment). That gives an exact per-frame
"stream latency" = wall clock at decode - PDT of the frame.
"""
import datetime as dt
import logging
import subprocess
import threading
import time

import requests

log = logging.getLogger("hls")


def resolve_playlist(channel: str, quality: str) -> str:
    """Return the media-playlist URL for a Twitch channel via streamlink."""
    qualities = [quality, "720p60", "720p", "best"]
    for q in dict.fromkeys(qualities):
        r = subprocess.run(
            ["streamlink", "--twitch-low-latency", "--stream-url",
             f"https://www.twitch.tv/{channel}", q],
            capture_output=True, text=True, timeout=60)
        url = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
        if url.startswith("http"):
            log.info("resolved %s quality=%s", channel, q)
            return url
        log.warning("streamlink %s %s failed: %s", channel, q, (r.stdout + r.stderr)[-300:])
    raise RuntimeError(f"could not resolve stream for {channel} (offline?)")


def parse_iso(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def parse_playlist(text: str):
    """Yield dicts {seq, pdt, dur, title, url, prefetch} for each segment."""
    seq = 0
    pdt = None
    dur = None
    title = ""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            seq = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pdt = parse_iso(line.split(":", 1)[1])
        elif line.startswith("#EXTINF:"):
            v = line.split(":", 1)[1]
            d, _, title = v.partition(",")
            dur = float(d)
        elif line.startswith("#EXT-X-TWITCH-PREFETCH:"):
            out.append(dict(seq=seq, pdt=None, dur=None, title="live",
                            url=line.split(":", 1)[1], prefetch=True))
            seq += 1
        elif line and not line.startswith("#"):
            out.append(dict(seq=seq, pdt=pdt, dur=dur, title=title, url=line, prefetch=False))
            seq += 1
            pdt = None
            dur = None
            title = ""
    return out


def first_video_pts(buf: bytes):
    """Return the first video PES PTS (seconds) in an MPEG-TS buffer, or None."""
    for i in range(0, len(buf) - 188 + 1, 188):
        p = buf[i:i + 188]
        if p[0] != 0x47 or not (p[1] & 0x40):  # sync + payload_unit_start
            continue
        afc = (p[3] >> 4) & 3
        off = 4
        if afc in (2, 3):
            off += 1 + p[4]
        if afc == 2 or off + 14 > 188:
            continue
        pes = p[off:]
        if pes[0:3] != b"\x00\x00\x01" or not (0xE0 <= pes[3] <= 0xEF):
            continue
        if not (pes[7] & 0x80):
            continue
        b = pes[9:14]
        pts = (((b[0] >> 1) & 7) << 30) | (b[1] << 22) | ((b[2] >> 1) << 15) | (b[3] << 7) | (b[4] >> 1)
        return pts / 90000.0
    return None


class HLSFetcher(threading.Thread):
    """Polls the playlist and writes new 'live' segments into `sink` (a binary
    file object, e.g. ffmpeg stdin). Records (pts_start, pdt, dur, seq, fetched_at)
    in self.segments for timestamp mapping. Skips Twitch stitched ad segments."""

    def __init__(self, channel, quality, sink, stop_event):
        super().__init__(daemon=True)
        self.channel = channel
        self.quality = quality
        self.sink = sink
        self.stop_event = stop_event
        self.segments = []  # list of dict
        self.lock = threading.Lock()
        self.sess = requests.Session()
        self.last_seq = None
        self.ad_segments = 0
        self.playlist_lag = None  # wall clock at playlist fetch - end of newest segment PDT
        self.error = None

    def run(self):
        try:
            self._run()
        except Exception as e:  # noqa
            log.exception("fetcher died")
            self.error = e
            self.stop_event.set()

    def _run(self):
        url = resolve_playlist(self.channel, self.quality)
        fails = 0
        while not self.stop_event.is_set():
            t0 = time.time()
            try:
                r = self.sess.get(url, timeout=10)
                if r.status_code in (403, 404, 410):
                    log.warning("playlist HTTP %s, re-resolving", r.status_code)
                    url = resolve_playlist(self.channel, self.quality)
                    continue
                r.raise_for_status()
                fails = 0
            except Exception as e:
                fails += 1
                log.warning("playlist fetch error %s (%d)", e, fails)
                if fails >= 5:
                    url = resolve_playlist(self.channel, self.quality)
                    fails = 0
                time.sleep(1)
                continue
            fetched_at = time.time()
            segs = parse_playlist(r.text)
            live = [s for s in segs if not s["prefetch"]]
            if live and live[-1]["pdt"]:
                self.playlist_lag = fetched_at - (live[-1]["pdt"] + live[-1]["dur"])
            if self.last_seq is None and live:
                # start at the live edge: newest complete segment only
                self.last_seq = live[-1]["seq"] - 1
            for s in live:
                if s["seq"] <= self.last_seq:
                    continue
                self.last_seq = s["seq"]
                if not s["title"].startswith("live"):
                    self.ad_segments += 1
                    continue
                try:
                    data = self.sess.get(s["url"], timeout=15).content
                except Exception as e:
                    log.warning("segment fetch failed: %s", e)
                    continue
                pts = first_video_pts(data)
                with self.lock:
                    self.segments.append(dict(seq=s["seq"], pdt=s["pdt"], dur=s["dur"], pts=pts,
                                              fetched_at=time.time()))
                    self.segments = self.segments[-200:]
                self.sink.write(data)
                self.sink.flush()
            # poll roughly every half segment
            time.sleep(max(0.2, 0.5 - (time.time() - t0)))

    def pts_to_pdt(self, pts):
        """Map a frame PTS (seconds, from -copyts) to ingest wall-clock time."""
        with self.lock:
            best = None
            for s in self.segments:
                if s["pts"] is None or s["pdt"] is None:
                    continue
                d = pts - s["pts"]
                if d < -1:
                    d += 2 ** 33 / 90000.0  # PTS wraparound
                if 0 <= d < (s["dur"] or 2) + 0.5:
                    best = s["pdt"] + d
            return best
