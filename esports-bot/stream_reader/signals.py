"""Extra scoreboard signals beyond kills/clock.

All coordinates are 1080p pixel coordinates of the full frame (read_stream.py
feeds the top-left 1440x820 region of the frame scaled to 1080p).

* top-bar gold lead: the spectator top bar shows "▲ 5k" (yellow) under the
  kill score of the team that is ahead in net worth. Resolution is 1k.
* net-worth panel (left side "Net Worth" list, shown by many broadcasts):
  10 rows sorted by net worth with a green (Radiant) or red (Dire) bar.
  Summing per colour gives the exact team net-worth difference.
* kill feed (left, above the minimap): OCR'd text lines; keywords for
  Roshan / Aegis / towers / barracks.
"""
import re

import cv2
import numpy as np
import pytesseract

from ocr import binarize

GOLD_BOXES = {"left": (872, 40, 920, 57), "right": (1008, 40, 1058, 57)}
GOLD_RE = re.compile(r"(\d{1,2}(?:\.\d)?)k")
TESS_GOLD = "--psm 7 --oem 1 -c tessedit_char_whitelist=0123456789.k"

# net worth panel
NW_ROW0_Y, NW_ROW_DY = 188, 34.35
NW_NUM_X = (66, 132)
NW_BAR_X = (100, 290)

FEED_BOX = (0, 560, 580, 775)


def _ocr(img, config):
    b = cv2.copyMakeBorder(img, 15, 15, 15, 15, cv2.BORDER_CONSTANT, value=255)
    return pytesseract.image_to_string(b, config=config).strip()


class GoldLeadReader:
    """Reads the top-bar gold lead. Returns signed value in gold
    (+ = left/Radiant ahead), 0 if no indicator on either side, None if
    unreadable/ambiguous."""

    def __init__(self):
        self.cache = {}

    def _side(self, frame, side):
        x0, y0, x1, y1 = GOLD_BOXES[side]
        m = binarize(frame[y0:y1, x0:x1], scale=4, thresh=160)
        if np.count_nonzero(m == 0) < 0.02 * m.size:
            return ""
        prev = self.cache.get(side)
        if prev is not None and prev[0].shape == m.shape and np.count_nonzero(prev[0] != m) < 0.004 * m.size:
            return prev[1]
        txt = _ocr(m, TESS_GOLD)
        self.cache[side] = (m, txt)
        return txt

    def read(self, frame):
        lt, rt = self._side(frame, "left"), self._side(frame, "right")
        lm, rm = GOLD_RE.search(lt), GOLD_RE.search(rt)
        if lm and not rm:
            return int(float(lm.group(1)) * 1000), (lt, rt)
        if rm and not lm:
            return -int(float(rm.group(1)) * 1000), (lt, rt)
        if not lt and not rt:
            return 0, (lt, rt)
        return None, (lt, rt)


class NetWorthPanel:
    """Reads the 10-row net worth panel. Returns (radiant_minus_dire, rows) or
    (None, reason)."""

    def read(self, frame):
        rows = []
        for i in range(10):
            yc = int(NW_ROW0_Y + i * NW_ROW_DY)
            bar = frame[yc - 4:yc + 5, NW_BAR_X[0]:NW_BAR_X[1]].astype(int)
            b, g, r = bar[..., 0], bar[..., 1], bar[..., 2]
            green = np.count_nonzero((g > 80) & (g > r + 45) & (g > b + 45))
            red = np.count_nonzero((r > 100) & (r > g + 55) & (r > b + 55))
            if green >= 4 and green > 3 * red:
                rows.append("R")
            elif red >= 4 and red > 3 * green:
                rows.append("D")
            else:
                return None, f"row {i} no bar"
        if rows.count("R") != 5:
            return None, "not 5/5 colours"
        y0 = int(NW_ROW0_Y - NW_ROW_DY / 2)
        y1 = int(NW_ROW0_Y + 9.5 * NW_ROW_DY)
        col = frame[y0:y1, NW_NUM_X[0]:NW_NUM_X[1]]
        # yellow digits
        b, g, r = col[..., 0].astype(int), col[..., 1].astype(int), col[..., 2].astype(int)
        mask = ((r > 150) & (g > 120) & (b < r - 30)).astype(np.uint8) * 255
        vals = []
        for i in range(10):
            ya = int(i * NW_ROW_DY + 6)
            yb = int((i + 1) * NW_ROW_DY - 6)
            m = cv2.resize(mask[ya:yb], None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
            m = 255 - cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)[1]
            vals.append(m)
        # OCR all ten rows in one tesseract call (stacked with spacing)
        pad = [cv2.copyMakeBorder(v, 8, 8, 0, 0, cv2.BORDER_CONSTANT, value=255) for v in vals]
        txt = _ocr(np.vstack(pad), "--psm 6 --oem 1 -c tessedit_char_whitelist=0123456789")
        nums = [t for t in re.split(r"\s+", txt) if t]
        if len(nums) != 10 or not all(n.isdigit() and 3 <= len(n) <= 5 for n in nums):
            return None, f"ocr {nums}"
        nums = [int(n) for n in nums]
        # rows are sorted descending; allow small OCR slack
        if any(nums[i] + 50 < nums[i + 1] for i in range(9)):
            return None, f"not sorted {nums}"
        rad = sum(n for n, c in zip(nums, rows) if c == "R")
        dire = sum(n for n, c in zip(nums, rows) if c == "D")
        return rad - dire, list(zip(rows, nums))


FEED_KEYWORDS = [
    ("roshan", re.compile(r"roshan", re.I)),
    ("aegis", re.compile(r"aegis", re.I)),
    ("barracks", re.compile(r"barrack|melee|ranged", re.I)),
    ("tower", re.compile(r"tower", re.I)),
    ("glyph", re.compile(r"glyph", re.I)),
]


def line_side(frame, yc):
    """Team colour of a feed line from its left-edge gradient:
    green-ish = Radiant, red-ish = Dire, else None."""
    px = frame[max(0, yc - 6):yc + 7, 0:7].reshape(-1, 3).astype(int)
    b, g, r = np.median(px[:, 0]), np.median(px[:, 1]), np.median(px[:, 2])
    if r - g > 15 and r > b:
        return "dire"
    if g - r > 12 and g > b:
        return "radiant"
    return None


class FeedReader:
    """OCR of the kill feed / event feed region. Returns list of text lines."""

    def __init__(self):
        self.prev = None
        self.prev_lines = []

    def read(self, frame):
        x0, y0, x1, y1 = FEED_BOX
        roi = frame[y0:y1, x0:x1]
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        small = cv2.resize(g, None, fx=0.25, fy=0.25)
        if self.prev is not None and np.mean(np.abs(small.astype(int) - self.prev.astype(int))) < 2.0:
            return self.prev_lines
        self.prev = small
        b = binarize(roi, scale=2, thresh=150)
        d = pytesseract.image_to_data(b, config="--psm 6 --oem 1", output_type=pytesseract.Output.DICT)
        groups = {}
        for i, w in enumerate(d["text"]):
            if not w.strip():
                continue
            k = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
            g = groups.setdefault(k, {"words": [], "ys": []})
            g["words"].append(w.strip())
            g["ys"].append(d["top"][i] / 2 + d["height"][i] / 4)
        lines = []
        for g in groups.values():
            txt = " ".join(g["words"])
            if len(txt) < 4:
                continue
            yc = int(y0 + sorted(g["ys"])[len(g["ys"]) // 2])
            lines.append((txt, yc, line_side(frame, yc)))
        self.prev_lines = lines
        return lines


def classify_feed_line(ln, tint=None):
    """Map an OCR'd feed line to (event, side_that_benefits) or None.
    Observed formats (spectator feed, 7.3x):
      'The Dire <icon> Roshan 135 <gold> each'          -> roshan, dire
      'Yuma <icon> Aegis of the Immortal'               -> (pickup, ignored)
      'Yuma <icon> Tower 110 <gold> each'               -> tower, side from line tint
      'The Dire <icon> Tower'                           -> tower, dire
      'RCY <icon> Radiant Top Ranged Barracks 90 each'  -> barracks lost by Radiant -> dire
    Line tint (left-edge gradient) is the acting team's colour."""
    low = re.sub(r"\s+", "", ln.lower())
    m = re.search(r"the(radiant|dire)", low)
    actor = m.group(1) if m else tint
    if "roshan" in low:
        return ("roshan", actor) if actor else None
    m = re.search(r"(radiant|dire)\w*barrack", low)
    if m or "barrack" in low:
        if m:
            return ("barracks_destroyed", "dire" if m.group(1) == "radiant" else "radiant")
        return ("barracks_destroyed", actor)
    if "tower" in low:
        return ("tower_destroyed", actor)
    return None


class SignalTracker:
    """Debounces gold lead / net worth / feed objectives. `update` returns a
    list of (event, confidence, extra_fields)."""

    def __init__(self, feed_log=None, gold_confirm=3, debug_dir=None, tag=""):
        self.debug_dir = debug_dir
        self.tag = tag
        self.gold = GoldLeadReader()
        self.panel = NetWorthPanel()
        self.feed = FeedReader()
        self.gold_confirm = gold_confirm
        self.gold_lead = None          # confirmed top-bar lead (k resolution)
        self.gold_cand, self.gold_n = None, 0
        self.nw_lead = None            # last emitted exact lead from panel
        self.nw_last_emit = 0
        self.nw_last_try = 0
        self.nw_prev = None            # previous validated panel value (needs 2 in a row)
        self.feed_last = 0
        self.feed_seen = {}            # line -> first seen stream time
        self.feed_counts = {}          # line -> consecutive sightings
        self.feed_log = open(feed_log, "a", buffering=1) if feed_log else None
        self.obj_last = {}             # objective kind -> stream time of last emit

    def update(self, frame, t, hud_ok, game_clock_s):
        events = []
        if not hud_ok:
            self.gold_cand, self.gold_n = None, 0
            return events
        # --- top-bar gold lead, every frame (OCR cached when unchanged)
        g, raw = self.gold.read(frame)
        if g is not None and g == self.gold_cand:
            self.gold_n += 1
        else:
            self.gold_cand, self.gold_n = g, (1 if g is not None else 0)
        diff = abs((g or 0) - self.gold_lead) if self.gold_lead is not None else None
        if diff is None or diff > 5000:
            need = 2 * self.gold_confirm       # first read / big jump: be careful
        elif diff >= 2000:
            need = self.gold_confirm            # real swing (fight/objective): fast
        else:
            need = 5 * self.gold_confirm        # 1k step: hysteresis vs boundary flapping (~4 s at 4 fps)
        if g is not None and self.gold_n >= need and g != self.gold_lead:
            prev = self.gold_lead
            self.gold_lead = g
            events.append(("gold_lead_change", 0.85, {"gold_lead": g, "gold_lead_prev": prev,
                                                      "gold_lead_source": "topbar_k"}))
        # --- net-worth panel every 5 s, cross-checked with top bar
        if t - self.nw_last_try >= 5:
            self.nw_last_try = t
            v, info = self.panel.read(frame)
            ok = (v is not None and self.gold_lead is not None and
                  abs(v - self.gold_lead) <= 1000 and (v == 0 or self.gold_lead == 0 or (v > 0) == (self.gold_lead > 0)))
            if ok and self.nw_prev is not None and abs(v - self.nw_prev) < 4000:
                if (self.nw_lead is None or abs(v - self.nw_lead) >= 1000) and t - self.nw_last_emit >= 10:
                    self.nw_lead = v
                    self.nw_last_emit = t
                    events.append(("networth", 0.8, {"gold_lead_exact": v, "gold_lead": self.gold_lead,
                                                    "gold_lead_source": "networth_panel"}))
            self.nw_prev = v if ok else None
        # --- feed every ~1 s
        if t - self.feed_last >= 1.0:
            self.feed_last = t
            lines = self.feed.read(frame)
            sigs = {}
            for ln, yc, tint in lines:
                if not re.search(r"[A-Za-z]{4,}", ln):
                    continue
                key = re.sub(r"\W+", "", ln.lower())[:40]
                if key not in self.feed_seen:
                    self.feed_seen[key] = t
                    if self.feed_log:
                        self.feed_log.write(f"{t:.1f}\t{game_clock_s}\t{tint}\t{ln}\n")
                    if self.debug_dir and re.search(r"the ?(radiant|dire)", ln, re.I):
                        x0, y0, x1, y1 = FEED_BOX
                        cv2.imwrite(f"{self.debug_dir}/{self.tag}_feed_{t:.0f}.png", frame[y0:y1, x0:x1])
                sig = classify_feed_line(ln, tint)
                if sig:
                    sigs[sig] = ln
            for sig, ln in sigs.items():
                self.feed_counts[sig] = self.feed_counts.get(sig, 0) + 1
                if self.feed_counts[sig] != 2:   # seen on 2 consecutive feed reads; emit once
                    continue
                ev, side = sig
                window = 300 if ev == "roshan" else 10
                if t - self.obj_last.get(sig, -1e9) < window:
                    continue
                self.obj_last[sig] = t
                benefits = {"radiant": "left", "dire": "right"}.get(side)
                events.append((ev, 0.8 if benefits else 0.6,
                               {"objective": ev, "benefits": benefits, "feed_text": ln}))
            for k in list(self.feed_counts):
                if k not in sigs:
                    del self.feed_counts[k]
            if len(self.feed_seen) > 2000:
                self.feed_seen = dict(list(self.feed_seen.items())[-500:])
        return events
