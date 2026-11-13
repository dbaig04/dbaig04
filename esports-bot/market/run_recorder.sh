#!/bin/bash
# Keep the Polymarket price recorder alive: restart 10s after any exit.
cd "$(dirname "$0")/.."
while true; do
  python3 market/record_prices.py >> data/recorder.log 2>&1 < /dev/null
  echo "$(date -u +%FT%TZ) recorder exited ($?), restarting in 10s" >> data/recorder.log
  sleep 10
done
