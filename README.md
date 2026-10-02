# smart-web-search-mcp

**English** | [中文说明见下](#中文说明)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) stdio server that exposes **one** LLM tool — `smart_web_search` — backed by a 5-provider fusion router with automatic cascade fallback:

```
L1  wigolo (stdio, 18 engines, free) + keenable (HTTP, free tier)   in parallel
L2  tinyfish (wallet) → tavily (1000/mo free)                       serial pair
L3  serper (Google; 2500 one-time free, then paid)                  unconditional fallback
```

The router picks the first layer with enough results and stops — cheap providers answer first, paid ones only fire when needed. Every call returns the full routing chain so the LLM can learn which layer served it.

The package ships two console commands:

- `smart-web-search-mcp` — the MCP stdio server (spawn-per-call core, zero cross-call state; Node ≥ 22.7 required for strip-only TypeScript execution — no build step)
- `smart-web-search-install` — a zero-dependency Python installer that detects installed AI agent CLIs (pi, Cursor, Cline, opencode, zcode, Qoder, mcode, commandcode, dsh, reasonix) and idempotently wires the MCP entry into each one's config

## Install

```bash
uv tool install smart-web-search-mcp    # or: pipx install smart-web-search-mcp
smart-web-search-install --list         # detect installed agents (read-only)
smart-web-search-install --dry-run      # preview config writes
smart-web-search-install                # wire all detected agents (idempotent)
```

Manual MCP config (any client that speaks stdio MCP):

```
command: smart-web-search-mcp
args:    []
```

## Provider keys (all optional)

| Provider | Tier | Without key | With key |
|---|---|---|---|
| wigolo | L1, free | needs `npm i -g wigolo` | — |
| keenable | L1, free | shared public tier (1K req/hour, auto-backoff on 429) | 100K/mo (`KEENABLE_API_KEY`) |
| tinyfish | L2, pay-as-you-go | skipped | `TINYFISH_API_KEY` |
| tavily | L2, 1000/mo free | skipped (opt-in) | `TAVILY_API_KEY` |
| serper | L3, paid after free quota | skipped (opt-in) | `SERPER_API_KEY` |

Keys are read from environment variables or `~/.pi/agent/extensions/smart-web-search-mcp.config.json` (see `smart-web-search-mcp.config.example.json` shipped in the package). Without any keys, L1 wigolo still works — the search is functional out of the box.

Requirements: Python ≥ 3.10 (installer only), Node ≥ 22.7 (MCP server; uses built-in TypeScript type-stripping).

## 中文说明

`smart-web-search-mcp` 是一个 MCP stdio server：对 LLM 只暴露 **1 个** 工具 `smart_web_search`，内部按「梯次降级」策略路由 5 个搜索 provider——L1 wigolo + keenable（免费，并行）→ L2 tinyfish → tavily（串行）→ L3 serper（Google，无条件兜底）。低成本的层先答，付费层只在不够用时才烧；每次调用返回完整 routing chain，LLM 可感知是哪一层接住的。

### 安装

```bash
uv tool install smart-web-search-mcp    # 或 pipx install smart-web-search-mcp
smart-web-search-install                # 自动探测本机 agent 并写入 MCP 配置（幂等）
```

支持自动探测并写入 10 家 agent 的 MCP 配置：pi（≥0.99.0 内置 MCP，旧扩展自动迁移）/ Cursor / Cline / opencode / zcode / Qoder CLI / mcode（MiniMax Code）/ commandcode / dsh / reasonix。未安装的自动跳过；覆盖已有条目前备份 `.bak`。

### 凭据

- 全部可选：不配任何 key 时 wigolo（L1）开箱即用。
- key 来源：环境变量（`TINYFISH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` / `KEENABLE_API_KEY`）或 `~/.pi/agent/extensions/smart-web-search-mcp.config.json`（opt-in 开关 + 显式 key，模板见包内 `smart-web-search-mcp.config.example.json`）。
- keenable 无 key 走共享公共层（1K 次/小时，429 自动节流 60s）。

### 工具参数（`smart_web_search`）

- `query`（必填）；`max_results`（默认 5）；`intent`（general/news/paper/code/research，影响路由）；`recency`（day/week/month/year）；`include_domains` / `exclude_domains`（逗号分隔域名黑白名单，跨层生效）；`depth`（basic/advanced）。

### 环境要求

- Python ≥ 3.10（安装器，零依赖）
- Node ≥ 22.7（MCP server 核心：TS strip-only 直跑，免 esbuild/免打包）
- 可选：`npm i -g wigolo`（L1 免费源；缺失自动降级到其它层）

## License

MIT
