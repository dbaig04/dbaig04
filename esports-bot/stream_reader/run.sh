#!/bin/bash
# Supervisor: keeps a reader running (restarts after crashes / stream hiccups).
# usage: stream_reader/run.sh --channel esl_dota2 --left-team A --right-team B
cd "$(dirname "$0")/.."
ch=$(echo "$@" | sed -n 's/.*--channel \([^ ]*\).*/\1/p')
while true; do
  python3 stream_reader/read_stream.py "$@" >> "data/reader_${ch}.log" 2>&1
  echo "$(date -u +%FT%TZ) reader exited ($?), restarting in 20s" >> "data/reader_${ch}.log"
  sleep 20
done
