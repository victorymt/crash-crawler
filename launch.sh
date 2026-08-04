#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-19765}"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export UV_CACHE_DIR

if ! command -v uv >/dev/null 2>&1; then
  printf '%s\n' "uv is required. Install uv, then run ./launch.sh again." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [[ ! -x "$PROJECT_ROOT/.venv/bin/python" ]] || ! "$PROJECT_ROOT/.venv/bin/python" -c 'import playwright' >/dev/null 2>&1; then
  printf '%s\n' "Preparing project virtual environment and Playwright..."
  UV_CACHE_DIR="$UV_CACHE_DIR" uv venv .venv
  UV_CACHE_DIR="$UV_CACHE_DIR" uv pip install -r requirements.txt
fi

if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  printf 'Local Web is already running at http://127.0.0.1:%s/\n' "$PORT"
  exit 0
fi

printf 'Starting local Web at http://127.0.0.1:%s/\n' "$PORT"
exec uv run python server.py "$PORT"
