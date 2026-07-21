#!/usr/bin/env python3
"""CLI for provider quota/usage crawling.

Examples:
    uv run python crawler.py
    uv run python crawler.py --provider deepseek
    uv run python crawler.py --explore --provider deepseek
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from providers import ProviderManager, load_config

RESULT_FILE = Path("result.json")


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(data, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", default="opencode-go", help="provider id to refresh")
    parser.add_argument("--all", action="store_true", help="refresh all enabled providers")
    parser.add_argument("--list-providers", action="store_true", help="list configured providers")
    parser.add_argument("--refresh-cookies", action="store_true", help="refresh provider auth when supported")
    parser.add_argument("--browser-fallback", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--explore", action="store_true", help="dump visible page text for a provider")
    parser.add_argument("--extract", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    try:
        manager = ProviderManager()

        if args.list_providers:
            print(
                json.dumps(
                    [config.__dict__ for config in load_config()],
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return

        if args.explore:
            path = manager.explore(args.provider)
            print(f"[explore] wrote {path}")
            return

        if args.all:
            result = manager.refresh_all()
            write_json(RESULT_FILE, result)
            return

        provider = manager.get_provider(args.provider)
        result = provider.fetch(
            refresh_auth=args.refresh_cookies,
            browser_fallback=args.browser_fallback or args.provider == "opencode-go",
        )
        manager.cache.setdefault("providers", {})[args.provider] = result
        manager.save_cache()

        legacy = result.get("raw") if args.provider == "opencode-go" else result
        write_json(RESULT_FILE, legacy)
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
