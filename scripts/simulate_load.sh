#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
STROKES="${1:-8}"
DELAY_MS="${2:-120}"

if ! [[ "$STROKES" =~ ^[0-9]+$ ]] || ! [[ "$DELAY_MS" =~ ^[0-9]+$ ]]; then
  echo "Usage: ./scripts/synthetic_commit_test.sh [strokes_count] [delay_ms]"
  exit 1
fi

get_committed_count() {
  curl -s "$GATEWAY_URL/committed-log" | grep -Eo '"count":[0-9]+' | head -n1 | cut -d ':' -f2
}

leader_node="$(curl -s "$GATEWAY_URL/leader" | grep -Eo '"nodeId":"[^"]+"' | head -n1 | cut -d '"' -f4)"
if [[ -z "$leader_node" ]]; then
  echo "No leader node available from gateway: $GATEWAY_URL/leader"
  exit 1
fi

leader_num="$(echo "$leader_node" | sed 's/replica//')"
if ! [[ "$leader_num" =~ ^[0-9]+$ ]]; then
  echo "Invalid leader node id: $leader_node"
  exit 1
fi

leader_port="$((5000 + leader_num))"
leader_url="http://localhost:${leader_port}"

before_count="$(get_committed_count)"
if [[ -z "$before_count" ]]; then
  echo "Failed to read committed count"
  exit 1
fi

ok=0
fail=0

echo "Leader URL: $leader_url"
echo "Committed count before: $before_count"
echo "Sending $STROKES synthetic draw command(s)..."

for ((i=1; i<=STROKES; i++)); do
  x1=$((20 + (i * 11) % 420))
  y1=$((30 + (i * 17) % 260))
  x2=$((x1 + 16 + (i % 20)))
  y2=$((y1 + 10 + (i % 15)))

  payload="{\"command\":{\"action\":\"draw\",\"stroke\":{\"from\":{\"x\":$x1,\"y\":$y1},\"to\":{\"x\":$x2,\"y\":$y2},\"color\":\"#1e8f5e\",\"width\":3}}}"

  code="$(curl -s -o /tmp/miniraft_stroke_resp.json -w "%{http_code}" -X POST "$leader_url/client-entry" -H 'Content-Type: application/json' -d "$payload" || true)"

  if [[ "$code" == "200" ]]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
  fi

  if [[ "$DELAY_MS" -gt 0 ]]; then
    sleep "0.$(printf '%03d' "$DELAY_MS")"
  fi
done

sleep 1
after_count="$(get_committed_count)"
if [[ -z "$after_count" ]]; then
  echo "Failed to read committed count after writes"
  exit 1
fi

delta=$((after_count - before_count))

echo ""
echo "Results:"
echo "  Successful POSTs: $ok"
echo "  Failed POSTs: $fail"
echo "  Committed count after: $after_count"
echo "  Committed delta: $delta"

if [[ "$delta" -gt 0 ]]; then
  echo "PASS: backend commit pipeline is advancing."
  exit 0
fi

echo "FAIL: no new committed entries observed."
exit 2
