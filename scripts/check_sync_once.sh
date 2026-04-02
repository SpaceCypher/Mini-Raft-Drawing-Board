#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"

echo "Leader:"
curl -s "$GATEWAY_URL/leader"
echo ""

echo "Replica status summary:"
for p in 5001 5002 5003 5004; do
  echo "-- :$p --"
  curl -s "http://localhost:$p/status" || echo "unreachable"
  echo ""
done

echo "Committed log count:"
curl -s "$GATEWAY_URL/committed-log" | sed -n 's/.*"count":\([0-9][0-9]*\).*/count=\1/p'

echo "Gateway connect/disconnect in last 60s:"
echo -n "connected="
docker logs gateway --since 60s 2>&1 | grep -c 'client connected' || true
echo -n "disconnected="
docker logs gateway --since 60s 2>&1 | grep -c 'client disconnected' || true
