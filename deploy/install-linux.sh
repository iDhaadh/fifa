#!/usr/bin/env bash
# One-shot installer for Channel Gateway on Debian/Ubuntu.
# Run as root (or with sudo):  sudo bash deploy/install-linux.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/channel-gateway}"
RUN_USER="${RUN_USER:-$(logname 2>/dev/null || echo "$SUDO_USER")}"
REPO="${REPO:-https://github.com/iDhaadh/fifa.git}"

echo ">> Installing dependencies (node, npm, ffmpeg, git)…"
if command -v apt-get >/dev/null; then
  apt-get update -y
  apt-get install -y ffmpeg git curl ca-certificates
  if ! command -v node >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
else
  echo "This script targets Debian/Ubuntu. Install node, npm and ffmpeg manually, then re-run." >&2
  exit 1
fi

echo ">> Fetching app into ${APP_DIR}…"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull
else
  git clone "${REPO}" "${APP_DIR}"
fi

cd "${APP_DIR}"
npm install --omit=dev

if [ ! -f config.json ]; then
  cp config.example.json config.json
  SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
  # fill a random cookieSecret; you still must set the password + channels
  node -e "const fs=require('fs');const c=require('./config.json');c.cookieSecret='${SECRET}';fs.writeFileSync('config.json',JSON.stringify(c,null,2))"
  echo ">> Created config.json — EDIT IT NOW: set \"password\" and your channels."
fi

echo ">> Installing systemd service…"
SERVICE=/etc/systemd/system/channel-gateway.service
sed -e "s#CHANGE_ME_USER#${RUN_USER}#" \
    -e "s#/opt/channel-gateway#${APP_DIR}#g" \
    -e "s#/usr/bin/node#$(command -v node)#" \
    deploy/channel-gateway.service > "${SERVICE}"
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

systemctl daemon-reload
systemctl enable channel-gateway
systemctl restart channel-gateway
echo ">> Done. Status:"
systemctl --no-pager status channel-gateway | head -12
echo
echo "Next: edit ${APP_DIR}/config.json (password + channels), then:"
echo "  sudo systemctl restart channel-gateway"
