"""Scoreboard OCR for the Dota 2 top bar.

ffmpeg delivers the top STRIP_FRAC of the frame scaled to STRIP_W x STRIP_H
(i.e. 1080p-equivalent pixel coordinates). The in-game top bar has
radiant kills | clock | dire kills centred around x=960.

Approach: binarise bright (white) text in the centre box, run tesseract once
(sparse text, digits/colon/minus whitelist) and take word *positions* into
account: the word containing ':' is the clock, the nearest word left of it is
radiant (left) kills, the nearest right is dire (right) kills.
Per-region results are cached by a coarse image hash so unchanged kill digits
are not re-OCR'd.
"""
import os
import re

import cv2
import numpy as np
import pytesseract

STRIP_W, STRIP_H = 1920, 81
STRIP_FRAC = 0.075

# centre box (1080p coords) containing kills + clock; overridable via env
CX0, CX1 = [int(v) for v in os.environ.get("SB_CENTER_X", "780,1140").split(",")]
CY0, CY1 = [int(v) for v in os.environ.get("SB_CENTER_Y", "0,60").split(",")]

CLOCK_RE = re.compile(r"^(-?)(\d{1,2}):(\d{2})$")
TESS_DIGITS = "--psm 11 --oem 1 -c tessedit_char_whitelist=0123456789:-"


def binarize(img_bgr, scale=3):
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    # white-ish text: bright and low saturation
    m = ((g > 165) & (hsv[..., 1] < 90)).astype(np.uint8) * 255
    m = cv2.resize(m, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    m = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)[1]
    return 255 - m  # black text on white


class ScoreboardOCR:
    def __init__(self):
        self.last_boxes = {}

    def read(self, strip):
        """Return (left_kills, right_kills, clock_seconds, raw_words)."""
        roi = strip[CY0:CY1, CX0:CX1]
        b = binarize(roi)
        b = cv2.copyMakeBorder(b, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
        d = pytesseract.image_to_data(b, config=TESS_DIGITS, output_type=pytesseract.Output.DICT)
        words = []
        for i, txt in enumerate(d["text"]):
            txt = txt.strip()
            if not txt or float(d["conf"][i]) < 30:
                continue
            x = (d["left"][i] - 20) / 3 + CX0
            w = d["width"][i] / 3
            h = d["height"][i] / 3
            words.append((x, x + w, txt, float(d["conf"][i]), h))
        words.sort()
        clock = None
        ci = None
        for i, (x0, x1, t, conf, h) in enumerate(words):
            m = CLOCK_RE.match(t)
            if m and int(m.group(3)) < 60 and abs((x0 + x1) / 2 - 960) < 60:
                s = int(m.group(2)) * 60 + int(m.group(3))
                clock = -s if m.group(1) else s
                ci = i
                break
        left = right = None
        if ci is not None:
            cx0, cx1 = words[ci][0], words[ci][1]
            lefts = [w for w in words[:ci] if w[2].isdigit() and cx0 - w[1] < 130]
            rights = [w for w in words[ci + 1:] if w[2].isdigit() and w[0] - cx1 < 130]
            if lefts:
                left = int(lefts[-1][2])
                self.last_boxes["left"] = lefts[-1][:2]
            if rights:
                right = int(rights[0][2])
                self.last_boxes["right"] = rights[0][:2]
            self.last_boxes["clock"] = (cx0, cx1)
            if left is not None and left > 199:
                left = None
            if right is not None and right > 199:
                right = None
        raw = [(round(w[0]), w[2], round(w[3])) for w in words]
        return left, right, clock, raw

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
        cv2.rectangle(img, (CX0, CY0), (CX1 - 1, CY1 - 1), (0, 255, 255), 1)
        for k, (x0, x1) in self.last_boxes.items():
            cv2.rectangle(img, (int(x0), CY0 + 2), (int(x1), CY1 - 2), (0, 0, 255), 1)
        return img
