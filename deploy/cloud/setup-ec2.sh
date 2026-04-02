#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <git_repo_url>"
  exit 1
fi

REPO_URL="$1"
APP_DIR="$HOME/miniRAFT"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi

if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get install -y docker-compose-plugin
fi

sudo usermod -aG docker "$USER" || true

if [[ -d "$APP_DIR" ]]; then
  rm -rf "$APP_DIR"
fi

git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

docker compose up -d --build

echo "Deployment finished. Open ports: 4000, 8080, 8090, 5001-5004 as needed."
