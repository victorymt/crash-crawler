#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-19765}"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
BROWSER_BIN_PATH="${PROVIDER_BROWSER_BIN:-${BROWSEROS_BIN:-}}"

if ! mkdir -p "$UV_CACHE_DIR" 2>/dev/null || [[ ! -w "$UV_CACHE_DIR" ]]; then
  printf 'UV cache directory %s is not writable; using /tmp/uv-cache instead.\n' "$UV_CACHE_DIR" >&2
  UV_CACHE_DIR="/tmp/uv-cache"
  mkdir -p "$UV_CACHE_DIR"
fi
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

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
    | "$PROJECT_ROOT/.venv/bin/python" -c 'import json, sys; data = json.load(sys.stdin); raise SystemExit(0 if data.get("service") == "provider-usage-hub" and data.get("ok") is True else 1)' >/dev/null 2>&1; then
    printf 'Local Web is already running at http://127.0.0.1:%s/\n' "$PORT"
    exit 0
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    printf 'Port %s is occupied by an incompatible or outdated service. Stop it, then run ./launch.sh again.\n' "$PORT" >&2
    exit 1
  fi
fi

if [[ -z "$BROWSER_BIN_PATH" ]]; then
  for browser_name in chromium chromium-browser google-chrome; do
    if command -v "$browser_name" >/dev/null 2>&1; then
      BROWSER_BIN_PATH="$(command -v "$browser_name")"
      break
    fi
  done
fi

if [[ -z "$BROWSER_BIN_PATH" || ! -x "$BROWSER_BIN_PATH" ]]; then
  printf 'A Chromium executable is required. Install Chromium or set PROVIDER_BROWSER_BIN, then retry.\n' >&2
  exit 1
fi
export PROVIDER_BROWSER_BIN="$BROWSER_BIN_PATH"

printf 'Starting local Web at http://127.0.0.1:%s/\n' "$PORT"
exec uv run python server.py "$PORT"
