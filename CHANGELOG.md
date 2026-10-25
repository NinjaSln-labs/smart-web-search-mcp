# Changelog

本文件记录所有对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 SemVer。

## [Unreleased]

## [0.3.0] — 2026-10-26

### Added

- **遥测 v2：CLI/MCP 路径逐条落盘。** 此前 `writeLog` 的两个调用点都只在 pi 扩展代码路径内，而 pi 自内置 MCP 起走的是 `server.mjs` spawn `node 核心.ts '{json}'`（CLI 路径）⇒ 生产搜索一行遥测都不写（本机实测：10-03…10-25 零样本，23 天）。现在两条路径共用同一装配点 `buildSearchLogEntry`；每行新增 `v`(=2) / `via`(mcp|cli|pi|test) / `version` / `providers`（当次四家 provider 配置态）/ 各层 `skip_reason` / `final.wall_ms`（端到端，与 Σ 各层的 `total_latency_ms` 并列）。
- 环境变量：`SMART_WS_LOG_PATH`（落位覆盖，测试隔离用）、`SMART_WS_LOG_MAX_BYTES`（默认 8 MiB；超限 rename 成带时间戳的兄弟文件，**不删任何历史行**）、`SMART_WS_LOG_STALE_DAYS`（默认 7；日志陈旧时 stderr 告警）、`SMART_WS_VIA`（来源标签，server 注入 `mcp`）、`SMART_WS_CONFIG_PATH`（凭据 config 覆盖位）。

### Changed

- **日志落位迁出 `~/.pi/log/`** → `~/.local/state/smart-web-search/`（尊重 `XDG_STATE_HOME`）。本工具是 10 家客户端共用的 MCP server，不再寄生 pi 目录。首次运行把旧位置历史文件整体 rename 迁入（不覆盖、不删）；keenable 429 节流状态文件同迁。
- keenable 429 冷却判定收口成一条谓词：**缺 client → `skipped(disabled)`，只有无 key 的公共层才看冷却文件**。此前 CLI 路径不判 key，公共层写下的冷却会把认证层调用也误跳；pi 路径在 keenable 未启用时以 `TypeError` 冒充 `status:"error"`（"没配"被记成"失败"）。
- L1 并行调用、`stop_reason`/`sub_providers` 装饰、winner 选择抽为 `runL1` / `pickAnswer` 单源——此前 pi 与 CLI 各写一份且已经漂移，行为基线取生产一直在跑的 CLI 判据。

### Fixed

- `stop_reason` 不再覆盖 skip 行：旧装饰段无条件把 L1 两条目写成 `"ok"`，本机历史数据里有 58 行 `status:"skipped"` 却带 `stop_reason:"ok"`。skip 的原因改由独立字段 `skip_reason`（`hint | throttled | satisfied | disabled | not_tried`）承载。
- e2e 不再污染生产遥测日志（此前每跑一次就往真落位追加快照行）；并新增 CLI 模式场景断言"一次搜索恰好一行"——缺这条回归闸正是 23 天零样本无人察觉的根因。
- 核心 `.ts` 的 `const VERSION` 与 `pyproject.toml` 版本由测试钉住（遥测行的 `version` 字段是双写，漂移即红）。

## [0.2.2] — 2026-10-26

### Fixed

- **v0.2.1 wheel 缺运行资产（无法使用）**：`.gitignore` 的 `build/` 规则误杀了 vendored 的 `typebox/build/`，使其从未被 git 跟踪——发布的 wheel 里 `typebox` 只剩顶层 3 个文件，核心启动即 `ERR_MODULE_NOT_FOUND`。v0.2.0 同样缺失，此前一直被 `server.py` 的"真源仓优先"降级掩盖（本机恰好装了真源仓）；v0.2.1 移除降级后在干净环境暴露。
  修复：`build/` 收窄为 `/build/`（仅指 setuptools 产物目录）；正式纳入 vendored `typebox` 全部文件；`verify.py` 增 vendored-assets 守卫，CI 与发布前同源校验，杜绝再发缺件包。

> 注：0.2.1 的功能变更（看门狗/取消处理/诊断日志/级联预算/发布包自洽）随本版本一并生效。

## [0.2.1] — 2026-10-26

### Fixed

- **工具调用无限静默（"卡住只能手动取消"）根治**：`server.mjs` 的 `runCoreOnce` 加看门狗——核心子进程超过 120s（`SMART_WS_WATCHDOG_MS` 可调）必被 SIGKILL 并回明确 `isError` 结果；QoderCN 等无自动超时的客户端不再无限等待。
- 处理 `notifications/cancelled`：用户取消后杀掉对应核心子进程（省资源），并按 MCP 规范不再回包。
- `tools/call` 收包 / 回包 / 取消 / 看门狗触发全部写 stderr 诊断行——下次异常可直接区分"请求没进 server"与"响应没发出"。
- 级联超时预算收紧：L1 wigolo 90→45s、L2/L3 30→20s，最坏链路 105s < 120s 看门狗，健康慢调用不会被误杀。

### Changed

- **发布包自洽**：`server.py` 删除"真源仓路径优先"的静默降级，发布包只使用包内副本；`SMART_WEB_SEARCH_SERVER` 环境变量保留为显式开发通道。

## [0.2.0] — 2026-10-02

### Fixed

- **tavily L2 复活**：其一，旧 API key 已失效（vault 单源已更新）；其二，tavily MCP 的 `tavily_search` 已把 `topic` 钉死为 const `"general"`，核心不再映射 newsMode→`topic:"news"`（传了即 422 literal_error）。实测 extract 类查询 L2 tavily 正常接住。

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
