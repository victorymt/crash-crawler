#!/usr/bin/env python3
"""Local provider console dashboard."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from providers import ProviderManager, load_config

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 19765


def json_bytes(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def public_configs() -> list[dict[str, object]]:
    return [
        {
            "id": config.id,
            "name": config.name,
            "type": config.type,
            "target_url": config.target_url,
            "enabled": config.enabled,
            "mode": config.mode,
        }
        for config in load_config()
        if config.enabled
    ]


def dashboard_html() -> str:
    providers = public_configs()
    provider_json = json.dumps(providers, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Provider Usage Hub</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-2: #eef2f7;
      --text: #17202a;
      --muted: #667085;
      --line: #d7dde6;
      --accent: #1677ff;
      --bad: #c2410c;
      --ok: #16803c;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #111418;
        --panel: #181d23;
        --panel-2: #202833;
        --text: #e7edf5;
        --muted: #9aa7b7;
        --line: #313a46;
        --accent: #5aa2ff;
        --bad: #ff9b72;
        --ok: #64d987;
        --shadow: none;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }}
    header {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 10;
    }}
    h1 {{
      margin: 0;
      font-size: 18px;
      font-weight: 650;
    }}
    .toolbar {{
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }}
    button, a.button {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }}
    button.primary, a.primary {{
      border-color: var(--accent);
      color: #fff;
      background: var(--accent);
    }}
    button:disabled {{
      opacity: 0.55;
      cursor: wait;
    }}
    main {{
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
      gap: 12px;
      padding: 12px;
      min-height: calc(100vh - 58px);
    }}
    aside {{
      min-width: 0;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }}
    .status-header {{
      padding: 12px;
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }}
    .provider-row {{
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }}
    .provider-row:last-child {{ border-bottom: 0; }}
    .provider-name {{
      font-weight: 650;
      overflow-wrap: anywhere;
    }}
    .provider-meta {{
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }}
    .status {{
      align-self: start;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
    }}
    .status.ok {{ color: var(--ok); border-color: color-mix(in srgb, var(--ok), var(--line) 55%); }}
    .status.error, .status.stale {{ color: var(--bad); border-color: color-mix(in srgb, var(--bad), var(--line) 55%); }}
    .metrics {{
      grid-column: 1 / -1;
      display: grid;
      gap: 6px;
      margin-top: 4px;
    }}
    .metric {{
      display: grid;
      gap: 4px;
      min-width: 0;
    }}
    .metric-top {{
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }}
    .bar {{
      height: 7px;
      border-radius: 999px;
      background: var(--panel-2);
      overflow: hidden;
    }}
    .bar > i {{
      display: block;
      height: 100%;
      width: var(--value, 0%);
      background: var(--accent);
    }}
    .error {{
      grid-column: 1 / -1;
      color: var(--bad);
      font-size: 12px;
      overflow-wrap: anywhere;
    }}
    .launchers {{
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(280px, 1fr));
      align-content: start;
      gap: 12px;
    }}
    .launch-panel {{
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 190px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }}
    .section-title {{
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }}
    .amount-grid {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }}
    .amount {{
      min-width: 0;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
    }}
    .amount-label {{
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .amount-value {{
      margin-top: 3px;
      font-size: 18px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }}
    .recommendation {{
      border-radius: 6px;
      padding: 7px 9px;
      background: var(--panel-2);
      color: var(--muted);
    }}
    .recommendation.recharge {{
      color: var(--bad);
    }}
    .recommendation.ok {{
      color: var(--ok);
    }}
    .launch-head {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }}
    .launch-title {{
      min-width: 0;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .launch-url {{
      min-height: 42px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--muted);
      font: 12px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }}
    .launch-actions {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: auto;
    }}
    @media (max-width: 980px) {{
      main {{
        grid-template-columns: 1fr;
        height: auto;
      }}
      aside {{
        max-height: 280px;
      }}
      .launchers {{
        grid-template-columns: 1fr;
      }}
      .amount-grid {{
        grid-template-columns: 1fr;
      }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Provider Usage Hub</h1>
    <div class="toolbar">
      <button id="refresh-all">刷新解析</button>
      <button id="open-all">打开全部</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="status-header">状态</div>
      <div id="provider-list"></div>
    </aside>
    <section class="launchers" id="launchers"></section>
  </main>
  <script>
    const providers = {provider_json};

    function statusLabel(status) {{
      return ({{ ok: 'ok', stale: 'stale', error: 'error', idle: 'idle', unconfigured: 'unconfigured' }})[status] || status || 'idle';
    }}

    function recommendationLabel(value) {{
      return ({{ ok: '余额正常', watch: '需要关注', recharge: '建议充值' }})[value] || '需要关注';
    }}

    function openProvider(provider) {{
      window.open(provider.target_url, `_blank_provider_${{provider.id}}`, 'noopener');
    }}

    function balanceHtml(balance) {{
      const currency = balance.currency ? ` ${{balance.currency}}` : '';
      return `<div class="amount">
        <div class="amount-label" title="${{balance.label}}">${{balance.label}}</div>
        <div class="amount-value">${{balance.value}}${{currency}}</div>
      </div>`;
    }}

    function renderLaunchers(snapshots = []) {{
      const root = document.getElementById('launchers');
      root.innerHTML = providers.map((provider) => {{
        const snapshot = snapshots.find((item) => item.id === provider.id) || {{}};
        const balances = snapshot.balances || [];
        const usage = snapshot.usage || snapshot.metrics || [];
        const balanceBlock = balances.length
          ? `<div class="section-title">余额</div><div class="amount-grid">${{balances.map(balanceHtml).join('')}}</div>`
          : '<div class="provider-meta">暂无余额数据。</div>';
        const usageBlock = usage.length
          ? `<div class="section-title">用量</div><div class="metrics">${{usage.map(metricHtml).join('')}}</div>`
          : '<div class="provider-meta">暂无用量数据。</div>';
        return `
        <article class="launch-panel">
          <div class="launch-head">
            <div class="launch-title" title="${{provider.target_url}}">${{provider.name}}</div>
            <span class="status ${{snapshot.status || ''}}">${{statusLabel(snapshot.status)}}</span>
          </div>
          <div class="recommendation ${{snapshot.recommendation || 'watch'}}">${{recommendationLabel(snapshot.recommendation)}}</div>
          ${{balanceBlock}}
          ${{usageBlock}}
          ${{snapshot.error ? `<div class="error">${{snapshot.error}}</div>` : ''}}
          <div class="launch-actions">
            <a class="button primary" href="${{provider.target_url}}" target="_blank">打开官方页面</a>
            <button data-copy="${{provider.id}}">复制 URL</button>
          </div>
        </article>
        `;
      }}).join('');
      root.querySelectorAll('[data-copy]').forEach((button) => {{
        button.addEventListener('click', () => {{
          const provider = providers.find((item) => item.id === button.dataset.copy);
          navigator.clipboard.writeText(provider.target_url);
        }});
      }});
    }}

    function metricHtml(metric) {{
      const value = metric.value || '';
      const percent = Number.isFinite(metric.percent) ? Math.max(0, Math.min(100, metric.percent)) : null;
      const bar = percent === null ? '' : `<div class="bar"><i style="--value: ${{percent}}%"></i></div>`;
      const right = metric.reset_in ? `重置: ${{metric.reset_in}}` : value;
      return `<div class="metric">
        <div class="metric-top"><span>${{metric.label}}</span><span>${{right || ''}}</span></div>
        ${{bar}}
      </div>`;
    }}

    async function loadStatus() {{
      const list = document.getElementById('provider-list');
      const response = await fetch('/api/providers');
      const data = await response.json();
      renderLaunchers(data.providers);
      list.innerHTML = data.providers.map((provider) => `
        <div class="provider-row">
          <div>
            <div class="provider-name">${{provider.name}}</div>
            <div class="provider-meta">${{provider.updated_at || '未解析'}}</div>
          </div>
          <span class="status ${{provider.status}}">${{statusLabel(provider.status)}}</span>
          <div class="metrics">
            ${{(provider.metrics || []).map(metricHtml).join('') || '<div class="provider-meta">暂无采集数据。</div>'}}
          </div>
          ${{provider.error ? `<div class="error">${{provider.error}}</div>` : ''}}
        </div>
      `).join('');
    }}

    async function refreshAll() {{
      const button = document.getElementById('refresh-all');
      button.disabled = true;
      try {{
        await fetch('/api/refresh', {{ method: 'POST' }});
        await loadStatus();
      }} finally {{
        button.disabled = false;
      }}
    }}

    document.getElementById('refresh-all').addEventListener('click', refreshAll);
    document.getElementById('open-all').addEventListener('click', () => providers.forEach(openProvider));
    renderLaunchers();
    loadStatus().then(refreshAll);
  </script>
</body>
</html>
"""


class DashboardHandler(BaseHTTPRequestHandler):
    manager = ProviderManager()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")

    def send_bytes(
        self,
        content: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(json_bytes(data), "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self.send_bytes(dashboard_html().encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/providers":
            self.send_json({"providers": self.manager.list_snapshots(), "configs": public_configs()})
            return
        if path.startswith("/dumps/"):
            self.serve_dump(path)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        if path == "/api/providers":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/refresh":
            self.send_json({"providers": self.manager.refresh_all()})
            return
        prefix = "/api/providers/"
        suffix = "/refresh"
        if path.startswith(prefix) and path.endswith(suffix):
            provider_id = unquote(path[len(prefix) : -len(suffix)].strip("/"))
            try:
                self.send_json({"provider": self.manager.refresh(provider_id)})
            except KeyError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def serve_dump(self, path: str) -> None:
        dump_path = (ROOT / path.lstrip("/")).resolve()
        dump_root = (ROOT / "dumps").resolve()
        if dump_root not in dump_path.parents or not dump_path.exists():
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(dump_path))[0] or "text/plain; charset=utf-8"
        self.send_bytes(dump_path.read_bytes(), content_type)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), DashboardHandler)
    print(f"[server] http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
