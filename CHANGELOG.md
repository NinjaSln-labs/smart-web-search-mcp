# Changelog

本文件记录所有对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 SemVer。

## [Unreleased]

## [0.2.0] — 2026-10-02

### Changed（Breaking-ish）

- **结果文本默认改为标签块格式**：不再把 provider 原始 JSON 作为结果文本返回，改为对 LLM 友好的 `[n] Title: / URL: / Published: / Source: / Snippet:` 块 + 一行路由页脚（`from L<n> <provider> | kept X of Y | dedup | layers | 耗时`），对齐 Exa/Tavily 官方 MCP 的输出形态；空结果回单句 `No results found (layers tried: …)`。
- **L1 展示条数收窄**：wigolo+keenable 双源结果按 URL 去重（wigolo 优先）后截到 `max_results`；0.1.x 为两源各截一份（最多 2×max）。路由充足性判定不变（仍按各层原始计数），只影响展示。

### Added

- 新参数 `output_format`（`text` 默认 | `json`）：json 模式返回结构化 envelope `{ query, results[], meta, chain }`，results 白名单字段 `title/url/snippet/published/source`。三处 schema（核心 SearchInput / pi Type.Object / mjs toJsonSchema）同步。
- provider 原始字段（relevance_score / evidence_score / cached / engine_pool 等）不再进入工具返回值（仍完整保留在 JSONL 日志）。
- 日志 `final.output_mode` 记录本次输出模式。


## [0.1.0] — 2026-10-02

### Added

- **MCP stdio server** `smart_web_search`：5-provider 融合搜索路由——L1 wigolo + keenable（免费，并行）→ L2 tinyfish → tavily（串行）→ L3 serper（无条件兜底）；每次调用返回完整 routing chain。
- **一键安装器** `smart-web-search-install`：自动探测 10 家 agent（pi / Cursor / Cline / opencode / zcode / Qoder / mcode / commandcode / dsh / reasonix），幂等写入 MCP 配置；pi 旧扩展自动迁移到内置 MCP。
- 零 Python 依赖（纯标准库）；Node ≥22.7 strip-only 直跑 TS 核心，免编译。
- keenable 公共层 429 自动节流；可配置 opt-in 的凭据解析（env / config）。
