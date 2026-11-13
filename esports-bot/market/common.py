"""Shared helpers for the Polymarket side of the esports research tool."""
import datetime as dt
import json
import os
import re
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CA_BUNDLE = "/root/.ccr/ca-bundle.crt"
PSKEY_PATH = os.environ.get(
    "PANDASCORE_KEY_FILE",
    "/tmp/claude-0/-home-user-dbaig04/79f5622c-9f77-5969-8fb9-6eeaaef17ec7/scratchpad/dota/.pskey",
)
TAKER_FEE_RATE = 0.05


def taker_fee(p, rate=TAKER_FEE_RATE):
    """Fee per share in $ for a taker fill at price p."""
    return rate * p * (1 - p)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_ts(s):
    """ISO string (with or without Z) or epoch seconds/ms -> epoch seconds float."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return s / 1000.0 if s > 1e11 else float(s)
    s = str(s).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        v = float(s)
        return v / 1000.0 if v > 1e11 else v
    s = s.replace("Z", "+00:00")
    t = dt.datetime.fromisoformat(s)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.timestamp()


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(team|esports|esport|gaming|club|academy)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def name_score(a, b, extra_aliases=()):
    """Crude similarity between a HUD/stream team name and a market outcome name (0..1)."""
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    for al in extra_aliases:
        if al and norm_name(al) == na:
            return 0.95
    if na in nb or nb in na:
        return 0.8 if min(len(na), len(nb)) >= 2 else 0.3
    # initials, e.g. "GL" vs "GamerLegion" (camel case) or "Zero Tenacity" -> "ZT"
    words = re.findall(r"[A-Z][a-z]*|[a-z]+|\d+", b or "")
    initials = "".join(w[0] for w in words).lower()
    if initials and initials == na:
        return 0.7
    common = len(set(na) & set(nb)) / max(len(set(na) | set(nb)), 1)
    return 0.4 * common


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # partially written last line
    return out
