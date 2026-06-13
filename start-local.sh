#!/usr/bin/env bash
# start-local.sh — clean and start grays-com for local testing
#
# Usage: ./start-local.sh
#
# What this does:
#   1. Kills leftover Node/Java processes from any previous session.
#   2. Verifies all grays-com ports are free — stops with a clear error if not.
#   3. Builds the Cloud Functions (TypeScript → JS).
#   4. Starts the Firebase emulators in the background (log → /tmp/grays-emulators.log).
#   5. Waits until the emulators are up, then starts the Vite frontend in the foreground.
#   6. Press Ctrl+C to stop everything (emulators are shut down automatically).

set -euo pipefail

# Change to the grays-com project root so all relative paths work.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Ports ───────────────────────────────────────────────────────────────────
# Source: firebase.json (emulators block)
PORT_AUTH=9100
PORT_FUNCTIONS=5004
PORT_FIRESTORE=8081
PORT_DATABASE=9001
PORT_HOSTING=5003
PORT_EMULATOR_UI=4001
# Source: frontend/vite.config.ts — no server.port set, so Vite defaults to 5173.
# If 5173 is already in use by another project Vite will auto-increment; we still
# check 5173 here to catch grays-com leftovers.
# TODO: if you want a fixed Vite port, add `server: { port: XXXX }` to vite.config.ts
PORT_VITE=5173

GRAYS_PORTS=($PORT_AUTH $PORT_FUNCTIONS $PORT_FIRESTORE $PORT_DATABASE $PORT_HOSTING $PORT_EMULATOR_UI $PORT_VITE)

# ─── 1. Kill leftover servers ─────────────────────────────────────────────────
echo "Killing old servers…"
killall node 2>/dev/null || true
# grays-com has no Java backend — this always says "no matching processes found";
# we suppress that noise and continue.
killall java 2>/dev/null || true

echo "Waiting 2 seconds for processes to exit…"
sleep 2

# ─── 2. Verify all ports are clear ───────────────────────────────────────────
echo "Checking ports…"
DIRTY=false
for port in "${GRAYS_PORTS[@]}"; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "  ⚠️  Port $port is still in use by PID $pid"
    echo "     Fix: kill -9 $pid"
    DIRTY=true
  fi
done

if [ "$DIRTY" = true ]; then
  echo ""
  echo "One or more ports are still occupied. Run the kill -9 commands above,"
  echo "then re-run this script."
  exit 1
fi

echo "Ports clear ✅"
echo ""

# ─── 3. Build Cloud Functions ─────────────────────────────────────────────────
# Source: functions/package.json — "build": "tsc"
# The emulator loads compiled JS from functions/lib/; we must build first.
echo "Building Cloud Functions…"
if ! (cd functions && npm run build); then
  echo ""
  echo "❌ Functions build failed. Fix the error above, then re-run."
  exit 1
fi
echo "Functions built ✅"
echo ""

# ─── 4. Start Firebase emulators in the background ───────────────────────────
# Source: firebase.json — all emulator ports and singleProjectMode are configured
# there; no extra flags needed. Output goes to a log file so it doesn't drown
# out the Vite output below. If the emulator fails to start, check:
#   cat /tmp/grays-emulators.log
echo "Starting Firebase emulators (log → /tmp/grays-emulators.log)…"
echo "  Auth:      http://localhost:${PORT_AUTH}"
echo "  Functions: http://localhost:${PORT_FUNCTIONS}"
echo "  Firestore: http://localhost:${PORT_FIRESTORE}"
echo "  Database:  http://localhost:${PORT_DATABASE}"
echo "  Hosting:   http://localhost:${PORT_HOSTING}"
echo "  UI:        http://localhost:${PORT_EMULATOR_UI}"

firebase emulators:start >"$TMPDIR/grays-emulators.log" 2>&1 &
EMULATOR_PID=$!

# Shut emulators down automatically when this script exits (Ctrl+C or error).
trap 'echo ""; echo "Shutting down emulators…"; kill "$EMULATOR_PID" 2>/dev/null; wait "$EMULATOR_PID" 2>/dev/null; echo "Done."' EXIT

# Wait for the functions emulator port to open — it's the last to come up.
echo ""
echo "Waiting for emulators to be ready…"
MAX_WAIT=90   # seconds
WAITED=0
while ! lsof -ti :"$PORT_FUNCTIONS" >/dev/null 2>&1; do
  sleep 1
  WAITED=$((WAITED + 1))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo ""
    echo "❌ Emulators didn't come up after ${MAX_WAIT}s."
    echo "   Check the log: cat $TMPDIR/grays-emulators.log"
    exit 1
  fi
done

echo "Emulators ready ✅"
echo ""

# ─── 5. Start the Vite frontend ───────────────────────────────────────────────
# Source: frontend/package.json — "dev": "vite"
# Runs in the foreground so output (including the Local: URL) is visible.
# Ctrl+C stops Vite and triggers the EXIT trap above to shut down the emulators.
echo "Starting frontend dev server…"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Open the Local: URL that Vite prints below."
echo "  (Default: http://localhost:${PORT_VITE} — may auto-increment if taken.)"
echo "  Press Ctrl+C to stop everything."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
(cd frontend && npm run dev)
