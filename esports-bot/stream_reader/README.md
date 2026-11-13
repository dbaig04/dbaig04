# stream_reader

Reads a live Dota 2 Twitch broadcast, OCRs the in-game top bar
(Radiant kills | game clock | Dire kills) and appends every confirmed change
to `data/stream_events.jsonl` with a wall-clock timestamp.

## Run

```bash
cd /home/user/dbaig04/esports-bot
nohup python3 stream_reader/read_stream.py --channel esl_dota2 \
    --left-team PlayTime --right-team HULIGANI \
    > data/reader_esl_dota2.log 2>&1 &
# stop:  pkill -f "read_stream.py --channel esl_dota2"
```

Options: `--fps 4` (default 4; OCR only re-runs when a field changes, so fps
mostly costs ffmpeg filter time), `--quality best` (1080p60 source; 720p is
cheaper to decode but the clock colon gets lost and OCR is worse), `--confirm 2`
(consecutive frames to confirm a change), `--duration N` (stop after N s),
`--verbose` (log every frame read), `--left-team/--right-team` (team names are
not OCR'd reliably; pass them in; `--ocr-teams` tries anyway).
Field boxes can be overridden with env vars `SB_LEFT`, `SB_CLOCK`, `SB_RIGHT`
(`x0,y0,x1,y1` in 1080p pixel coords) for a non-standard HUD.

## Dependencies

`pip install streamlink opencv-python-headless numpy pytesseract`,
`apt-get install -y tesseract-ocr`, ffmpeg. streamlink is used only to resolve
the Twitch media-playlist URL (access token); the HLS polling is done in
`hls.py`.

## Output (`data/stream_events.jsonl`)

```json
{"ts_utc": "2026-11-13T10:31:18.506Z", "channel": "esl_dota2", "game_clock": "12:29",
 "left_kills": 7, "right_kills": 6, "left_team": "PlayTime", "right_team": "HULIGANI",
 "event": "kill_change", "confidence": 0.95,
 "stream_pdt_utc": "2026-11-13T10:31:16.060Z", "latency_s": 2.45}
```

* `ts_utc` - wall clock when the frame came out of the decoder (event is
  emitted on the confirming frame, i.e. ~1/fps after the first frame showing it).
* `stream_pdt_utc` - Twitch `EXT-X-PROGRAM-DATE-TIME` of that exact frame
  (segment PDT + offset of the frame's PTS inside the segment).
  `latency_s = ts_utc - stream_pdt_utc` = Twitch ingest -> our decoded frame.
* events: `clock_start` (locked onto a game / new game), `kill_change`,
  `game_end_suspect` (HUD gone > 20 s after 10:00 game time), `heartbeat`
  (every ~30 s, with fps/latency/CPU stats and `last_read`).
* `left` = Radiant (left of clock), `right` = Dire.

Debug crops (top strip with the three OCR boxes in red) go to `data/debug/`:
one on every event, plus one every 120 s.

## How it works

1. `hls.py` polls the media playlist every ~0.5 s, starts at the live edge,
   downloads each new segment, skips Twitch stitched-ad segments (EXTINF title
   != `live`), records (first video PTS, PDT) per segment and pipes the TS
   bytes into ffmpeg's stdin.
2. ffmpeg (`-copyts`) selects ~fps frames, crops the top 7.5 % of the frame,
   scales it to 1920x81 and prints `showinfo` (PTS) for each frame.
3. `ocr.py` crops three fixed boxes (standard Dota 2 spectator top bar),
   thresholds bright text, upscales x4 and runs tesseract (`--psm 7`, digit
   whitelist). A box is only re-OCR'd when its binarised image changed.
4. `Tracker` (read_stream.py) debounces: needs 4 consistent frames with a
   real-time-advancing clock to lock on; afterwards a reading is used only if
   the clock is consistent with elapsed stream time (pauses allowed); a clock
   that jumps backwards (replays) is ignored; kills must not decrease; a new
   kill pair must be seen on 2 consecutive frames (4 if it jumps by > 6).
   A clock reset below 1:30 with <= 2 total kills triggers re-lock (new game).

## Known limits

* Fixed box positions assume the standard Dota 2 spectator HUD at 16:9.
  Broadcasts with a custom top bar need `SB_*` overrides.
* During full-screen replays / player cams / desk segments the top bar is
  absent -> no readings (kills seen later get timestamped when the HUD comes
  back). Replays that show the in-game HUD have an older clock and are ignored.
* Tournament broadcasts run with an intentional delay (typically minutes) vs the
  real game; this tool measures only Twitch-side latency (ingest -> us).
  Broadcaster encoder -> Twitch ingest is not observable.
* Twitch access tokens expire; on HTTP 403/404 the fetcher re-resolves the URL.
* Team names are not OCR'd (logos); pass `--left-team/--right-team`.
* Only kills + clock; towers/Roshan/net worth not implemented.
