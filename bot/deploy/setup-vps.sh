#!/usr/bin/env bash
# One-shot setup of the RISE/Meteora arb bot on an Ubuntu 24.04 VPS (e.g. ERPC VPS).
# Installs the bot in SIMULATE mode only. It never creates or loads a keypair.
#
# Usage (as the sudo-capable login user):
#   curl -fsSL <raw url of this file> -o setup-vps.sh   # or copy it over
#   sudo bash setup-vps.sh \
#     --repo https://github.com/<owner>/<repo>.git --branch <branch> \
#     --grpc https://<geyser-grpc-host> \
#     --shreds-port <udp port> --shreds-sources <ip1,ip2> \
#     [--rpc https://<rpc endpoint>] [--grpc-token-file /path/to/token]
#
# Re-running is safe: it updates the checkout, reinstalls deps and rewrites the
# managed keys in /etc/rise-arb/bot.env (other keys you added are kept).
set -euo pipefail

REPO="" BRANCH="main" GRPC="" RPC="https://api.mainnet-beta.solana.com" SHREDS_PORT="" SHREDS_SOURCES="" TOKEN_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --grpc) GRPC="$2"; shift 2 ;;
    --rpc) RPC="$2"; shift 2 ;;
    --shreds-port) SHREDS_PORT="$2"; shift 2 ;;
    --shreds-sources) SHREDS_SOURCES="$2"; shift 2 ;;
    --grpc-token-file) TOKEN_FILE="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" ]] || { echo "--repo is required" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }

APP_USER=arb
APP_HOME=/opt/rise-arb
APP_DIR=$APP_HOME/app/bot
ENV_FILE=/etc/rise-arb/bot.env

echo "== packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates ufw build-essential >/dev/null
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

echo "== user and checkout"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
if [[ -d $APP_HOME/app/.git ]]; then
  sudo -u "$APP_USER" git -C $APP_HOME/app fetch -q origin "$BRANCH"
  sudo -u "$APP_USER" git -C $APP_HOME/app checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone -q -b "$BRANCH" "$REPO" $APP_HOME/app
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund --loglevel=error
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"

echo "== config ($ENV_FILE)"
install -d -m 0750 -o root -g "$APP_USER" /etc/rise-arb
[[ -f $ENV_FILE ]] || install -m 0640 -o root -g "$APP_USER" deploy/.env.example "$ENV_FILE"
setkv() { # setkv KEY VALUE : replace or append, uncommenting a placeholder if present
  local k="$1" v="$2"
  if grep -qE "^#?${k}=" "$ENV_FILE"; then sed -i -E "s|^#?${k}=.*|${k}=${v}|" "$ENV_FILE"; else echo "${k}=${v}" >> "$ENV_FILE"; fi
}
setkv MODE simulate
setkv RPC_URL "$RPC"
[[ -n "$GRPC" ]] && setkv GRPC_ENDPOINT "$GRPC"
[[ -n "$TOKEN_FILE" ]] && setkv GRPC_X_TOKEN "$(tr -d '\n' < "$TOKEN_FILE")"
if [[ -n "$SHREDS_PORT" ]]; then
  setkv SHREDS_UDP_PORT "$SHREDS_PORT"
  [[ -n "$SHREDS_SOURCES" ]] && setkv SHREDS_UDP_ALLOWED_SOURCES "$SHREDS_SOURCES"
fi
chmod 0640 "$ENV_FILE"; chown root:"$APP_USER" "$ENV_FILE"

echo "== firewall"
ufw allow OpenSSH >/dev/null
if [[ -n "$SHREDS_PORT" ]]; then
  IFS=',' read -ra SRCS <<< "$SHREDS_SOURCES"
  if [[ ${#SRCS[@]} -gt 0 ]]; then
    for ip in "${SRCS[@]}"; do ufw allow proto udp from "$ip" to any port "$SHREDS_PORT" >/dev/null; done
  else
    ufw allow "$SHREDS_PORT"/udp >/dev/null
  fi
fi
ufw --force enable >/dev/null
# bigger UDP socket buffers for shreds
cat > /etc/sysctl.d/90-rise-arb.conf <<'EOF'
net.core.rmem_max=134217728
net.core.rmem_default=134217728
EOF
sysctl -q --system

echo "== service"
install -m 0644 deploy/rise-arb.service /etc/systemd/system/rise-arb.service
systemctl daemon-reload
systemctl enable -q rise-arb
systemctl restart rise-arb
sleep 8
systemctl --no-pager --lines=0 status rise-arb | head -5 || true
journalctl -u rise-arb --no-pager -n 20 | sed -E 's/(x-token|TOKEN)[^ ]*/\1=<redacted>/Ig'

cat <<EOF

Done. The bot is running in SIMULATE mode (no keypair, nothing is ever sent).
  logs:     journalctl -u rise-arb -f
  bench:    cd $APP_DIR && sudo -u $APP_USER bash -c 'set -a; . $ENV_FILE; set +a; npx tsx src/engine/bench.ts live --seconds 120'
  report:   cd $APP_DIR && sudo -u $APP_USER npx tsx src/engine/report.ts
  stop:     sudo systemctl stop rise-arb   (or emergency: sudo -u $APP_USER npx tsx src/engine/estop.ts)
EOF
