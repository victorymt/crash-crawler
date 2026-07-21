# Provider Usage Hub

本地 provider 用量聚合页。当前内置：

- OpenCode Go: `https://opencode.ai/workspace/wrk_01KW9MTABWQ0DNJ014CV528WC2/go`
- DeepSeek: `https://platform.deepseek.com/usage`

第一版优先把官方控制台入口放到一个本地看板里。官方页面通过新标签页打开，登录态由你正在使用的浏览器自然复用。
看板会自动采集可用的余额/用量数据，官方页面按钮保留用于查看细节和充值。

## 运行 Web 看板

首次运行先安装后端解析依赖：

```bash
UV_CACHE_DIR=/tmp/uv-cache uv pip install playwright
```

DeepSeek 余额使用官方 API，需要配置 API Key：

```bash
export DEEPSEEK_API_KEY=sk-...
```

```bash
uv run python server.py 19765
```

打开：

```text
http://127.0.0.1:19765
```

页面包含：

- 左侧 provider 状态。
- 右侧/下方余额、用量、重置时间和官方控制台入口。
- “打开全部”一次打开所有 provider 页面。
- “刷新解析”调用后端 provider 抓取逻辑，页面打开后也会自动刷新一次。

## 配置

默认不需要配置即可运行。需要改 URL 或 profile 时：

```bash
cp providers.example.json providers.local.json
```

然后编辑 `providers.local.json`。

本地文件不会提交：

- `providers.local.json`
- `.provider-cache.json`
- `dumps/`

## CLI

兼容原来的 OpenCode 抓取：

```bash
uv run python crawler.py
```

刷新所有 provider：

```bash
uv run python crawler.py --all
```

探索 DeepSeek 登录后页面文本：

```bash
uv run python crawler.py --provider deepseek --explore
```

## BrowserOS 登录态

后端解析模式需要 BrowserOS profile 副本：

```bash
cp -r /home/cv/.config/browser-os /home/cv/.browseros-crawler-profile
```

BrowserOS 关闭时复制最干净。Web 看板里的“打开”按钮不依赖这个副本，直接使用当前浏览器自己的登录态。

如果看到 `No module named 'playwright'`，说明当前 `.venv` 还没安装依赖：

```bash
UV_CACHE_DIR=/tmp/uv-cache uv pip install playwright
```

临时运行也可以：

```bash
uv run --with playwright python crawler.py --provider deepseek --explore
```

## 输出

- `result.json`: CLI 最近一次输出。
- `.provider-cache.json`: Web/API 最近一次成功或失败快照。
- `dumps/{provider}.txt`: provider parser 无法识别字段时的探索文本。
