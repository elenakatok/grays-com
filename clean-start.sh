#!/bin/bash
# clean-start.sh — surgically free grays-com emulator ports, then boot fresh.
#
# Only kills processes on the five grays-com emulator ports.
# Does NOT use killall node — other Firebase projects are left alone.
# After freeing ports, hands off to start-local.sh for the full boot sequence.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORTS=(5004 8081 4001 4400 4500)

echo "Freeing grays-com emulator ports..."
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    continue
  fi
  for pid in $pids; do
    echo "  Killing PID $pid on port $port"
    kill "$pid" 2>/dev/null || true
  done
done

sleep 1

exec "$SCRIPT_DIR/start-local.sh"
