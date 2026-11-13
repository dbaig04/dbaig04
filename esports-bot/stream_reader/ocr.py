"""Scoreboard OCR for the Dota 2 top bar.

ffmpeg delivers the top STRIP_FRAC of the frame scaled to STRIP_W x STRIP_H
(i.e. 1080p-equivalent pixel coordinates). The in-game top bar has
radiant kills | clock | dire kills centred around x=960.

Approach: three fixed boxes (left kills, clock, right kills) matching the
standard Dota 2 spectator top bar; bright low-saturation pixels are binarised
and read with tesseract (single line, digit whitelist). A field is only
re-OCR'd when its binarised image changed, so the kill fields cost ~nothing
between kills.
"""
import os
import re

import cv2
import numpy as np
import pytesseract

os.environ.setdefault("OMP_THREAD_LIMIT", "1")  # tesseract multithreading only adds overhead on tiny crops

STRIP_W, STRIP_H = 1920, 81
STRIP_FRAC = 0.075

# field boxes (x0, y0, x1, y1) in 1080p coords; override e.g. SB_LEFT="860,6,920,34"
def _box(name, default):
    return tuple(int(v) for v in os.environ.get(name, default).split(","))


BOXES = {
    "left": _box("SB_LEFT", "855,4,922,36"),
    "clock": _box("SB_CLOCK", "922,20,998,41"),
    "right": _box("SB_RIGHT", "998,4,1065,36"),
}
TESS_KILLS = "--psm 7 --oem 1 -c tessedit_char_whitelist=0123456789"
TESS_CLOCK = "--psm 7 --oem 1 -c tessedit_char_whitelist=0123456789:-"


def binarize(img_bgr, scale=4, thresh=160):
    """Bright HUD text -> black text on white, upscaled for tesseract."""
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return 255 - cv2.threshold(g, thresh, 255, cv2.THRESH_BINARY)[1]


def parse_clock(txt):
    """'10:29' / '1029' (colon lost) / '-0:45' -> seconds, else None."""
    neg = txt.startswith("-")
    d = re.sub(r"[^0-9]", "", txt)
    if not 3 <= len(d) <= 4 or txt.count(":") > 1:
        return None
    mm, ss = int(d[:-2]), int(d[-2:])
    if ss >= 60 or mm > 150:
        return None
    sec = mm * 60 + ss
    return -sec if neg else sec


class ScoreboardOCR:
    def __init__(self):
        self.cache = {}  # field -> (binarised image, text)
        self.ocr_calls = 0

    def _field(self, strip, name, config):
        x0, y0, x1, y1 = BOXES[name]
        b = binarize(strip[y0:y1, x0:x1])
        prev = self.cache.get(name)
        # skip OCR if the binarised field is (nearly) unchanged
        if prev is not None and prev[0].shape == b.shape and np.count_nonzero(prev[0] != b) < 0.004 * b.size:
            return prev[1]
        if np.count_nonzero(b == 0) < 0.01 * b.size:
            txt = ""
        else:
            bb = cv2.copyMakeBorder(b, 15, 15, 15, 15, cv2.BORDER_CONSTANT, value=255)
            txt = pytesseract.image_to_string(bb, config=config).strip().replace(" ", "")
            self.ocr_calls += 1
        self.cache[name] = (b, txt)
        return txt

    def read(self, strip):
        """Return (left_kills, right_kills, clock_seconds, raw_texts)."""
        lt = self._field(strip, "left", TESS_KILLS)
        rt = self._field(strip, "right", TESS_KILLS)
        ct = self._field(strip, "clock", TESS_CLOCK)
        left = int(lt) if lt.isdigit() and len(lt) <= 3 and int(lt) < 200 else None
        right = int(rt) if rt.isdigit() and len(rt) <= 3 and int(rt) < 200 else None
        clock = parse_clock(ct)
        return left, right, clock, (lt, ct, rt)

    def read_teams(self, strip):
        """Best-effort OCR of team names/tags at the far left/right of the strip."""
        res = []
        for x0, x1 in ((0, 620), (1300, 1920)):
            roi = strip[0:STRIP_H, x0:x1]
            b = binarize(roi, scale=2)
            d = pytesseract.image_to_data(b, config="--psm 11 --oem 1", output_type=pytesseract.Output.DICT)
            toks = [t.strip() for t, c in zip(d["text"], d["conf"])
                    if t.strip() and float(c) > 75 and re.fullmatch(r"[A-Za-z][A-Za-z0-9.\- ]{1,20}", t.strip())]
            res.append(" ".join(toks) if toks else None)
        return tuple(res)

    def annotate(self, strip):
        img = strip.copy()
        for x0, y0, x1, y1 in BOXES.values():
            cv2.rectangle(img, (x0, y0), (x1, y1), (0, 0, 255), 1)
        return img
