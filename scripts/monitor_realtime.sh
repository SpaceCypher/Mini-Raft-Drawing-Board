#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
REPLICA_PORTS=(5001 5002 5003 5004)
INTERVAL="${1:-2}"
last_commits=""
stagnant_rounds=0

extract_leader() {
  local raw
  raw="$(curl -s "$GATEWAY_URL/leader" || true)"
  echo "$raw" | sed -n 's/.*"nodeId":"\([^"]*\)".*"term":\([0-9][0-9]*\).*/\1 term=\2/p'
}

extract_commit_count() {
  local raw
  raw="$(curl -s "$GATEWAY_URL/committed-log" || true)"
  echo "$raw" | sed -n 's/.*"count":\([0-9][0-9]*\).*/\1/p'
}

extract_status_line() {
  local port="$1"
  local raw
  raw="$(curl -s "http://localhost:${port}/status" || true)"
  if [[ -z "$raw" ]]; then
    echo "replica@${port}: DOWN"
    return
  fi
  local node role term commit
  node="$(echo "$raw" | grep -Eo '"nodeId":"[^"]+"' | head -n1 | cut -d '"' -f4)"
  role="$(echo "$raw" | grep -Eo '"role":"[^"]+"' | head -n1 | cut -d '"' -f4)"
  term="$(echo "$raw" | grep -Eo '"currentTerm":[0-9]+' | head -n1 | cut -d ':' -f2)"
  commit="$(echo "$raw" | grep -Eo '"commitIndex":-?[0-9]+' | head -n1 | cut -d ':' -f2)"
  echo "${node}: role=${role} term=${term} commitIndex=${commit}"
}

while true; do
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  leader="$(extract_leader)"
  commits="$(extract_commit_count)"
  connected_last_min="$(docker logs gateway --since 60s 2>&1 | grep -c 'client connected' || true)"
  disconnected_last_min="$(docker logs gateway --since 60s 2>&1 | grep -c 'client disconnected' || true)"

  if [[ -n "$commits" && "$commits" == "$last_commits" ]]; then
    stagnant_rounds=$((stagnant_rounds + 1))
  else
    stagnant_rounds=0
  fi
  last_commits="$commits"

  echo ""
  echo "===== ${ts} ====="
  echo "Leader: ${leader:-unknown}"
  echo "Committed entries count: ${commits:-unknown}"
  echo "Gateway last 60s: connected=${connected_last_min} disconnected=${disconnected_last_min}"

  if [[ "$stagnant_rounds" -ge 5 && "$connected_last_min" -gt 0 ]]; then
    echo "ALERT: commit count is not increasing while clients reconnect; check websocket stability on client devices."
  fi

  for port in "${REPLICA_PORTS[@]}"; do
    extract_status_line "$port"
  done

  sleep "$INTERVAL"
done
