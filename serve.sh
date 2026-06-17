#!/bin/sh
# Serve the CAO Audit Navigator. Default port 8801 (8765 is taken by DAMA).
# Usage: ./serve.sh [port]
cd "$(dirname "$0")" || exit 1
PORT="${1:-8801}"
echo "CAO Audit Navigator → http://localhost:$PORT  (Ctrl+C to stop)"
exec python3 -m http.server "$PORT"
