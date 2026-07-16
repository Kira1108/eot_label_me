#!/usr/bin/env bash
cd "$(dirname "$0")"
PORT="${1:-8777}"
echo "打开 http://localhost:$PORT"
python3 -m http.server "$PORT"
