# 路由与凭据 / Routing & Providers

## 层级与级联策略

LLM 只看到 **1 个工具** `smart_web_search`，内部按「梯次降级」路由 5 个 provider：

```
L1  wigolo (stdio, 18 引擎, 免费) + keenable (HTTP, 免费层)   并行
L2  tinyfish (wallet 计费) → tavily (1000 次/月免费)           串行
L3  serper (Google; 一次性 2500 免费, 之后按量付费)             无条件兜底
```

- L1 两家并行；合并结果数 ≥ `max_results`（degraded 时 ≥3）即停
- L2 串行对：tinyfish 返回 error 或 0 结果才升 tavily
- L3 是无条件兜底：L1+L2 仍未满足就跑（这是「未满足即升」语义，L1 有零头结果也会升——基线约 18% 流量打到 L3，注意 serper 额度）

## 路由提示（v0，按调用日志调优中）

| 信号 | 行为 |
|---|---|
| `intent=news` 或 query 含 今天/最新/本周/news | 跳 L1，直进 L2（tinyfish 新闻能力强） |
| `intent=paper` 或 query 含 arxiv/paper/论文 | 跳 L1，直进 L2（research_paper domain_type） |
| `intent=code` 或 query 含 github/npm 等 | L1 include_domains 收敛到代码站 |
| `intent=research` / depth=advanced | tavily 用 `search_depth=advanced` |
| query 含 extract/crawl/scrape/map | 跳过 tinyfish（无这些工具），tavily 仍跑 |
| `include_domains` / `exclude_domains` | 跨层过滤（wigolo/tavily 数组、tinyfish 逗号串、keenable 取首域做 `site:`） |

## 每次调用返回什么

结果文本 + 完整 **routing chain**（每层 provider / status / result_count / latency / credits / error），LLM 可据此学习「L1 空了下次直接 L2」。

## 状态日志

JSONL 逐条落盘 `~/.pi/log/smart_web_search.jsonl`：`ts / request_id / input / chain[] / final`。这是路由策略调优的源数据。设置 `SMART_WS_LOG_RAW=0` 可在落盘前剥离各层的 raw_text 全文（防膨胀，指标保留）。

## 工具参数（`smart_web_search`）

| 参数 | 说明 |
|---|---|
| `query` | 必填，≤2000 字符 |
| `max_results` | 默认 5（1–50） |
| `intent` | general / news / paper / code / research，影响路由 |
| `recency` | day / week / month / year 时间过滤 |
| `include_domains` / `exclude_domains` | 逗号分隔域名黑白名单 |
| `depth` | basic（省）/ advanced（更全） |

## Provider 凭据与配额

| Provider | 层 | 无 key | 有 key |
|---|---|---|---|
| wigolo | L1 | 需 `npm i -g wigolo`，免费 | — |
| keenable | L1 | 共享公共层 1K 次/小时，429 自动节流 60s | 10 万次/月（`KEENABLE_API_KEY`） |
| tinyfish | L2 | 跳过 | wallet 按量计费（`TINYFISH_API_KEY`） |
| tavily | L2 | 跳过（opt-in） | 1000 次/月免费（`TAVILY_API_KEY`） |
| serper | L3 | 跳过（opt-in） | 2500 次一次性免费后付费（`SERPER_API_KEY`） |

key 优先级：config 显式 `key` > 环境变量 > `~/.cursor/mcp.json` / `~/.pi/agent/models.json`。配置文件路径：`~/.pi/agent/extensions/smart-web-search-mcp.config.json`（模板见包内 `smart-web-search-mcp.config.example.json`）。

## 页脚与日志

每次调用的文本输出以一行页脚收尾：`from L<n> <provider> | kept X of Y | dedup: R→D（L1 有重复时） | layers: <各层(状态 条数)> | <耗时>ms`——即路由决策的摘要视图；完整细节（含各层 raw_text、usage、engine_pool）只落 `~/.pi/log/smart_web_search.jsonl`，不进工具返回值。路由判定（充足性/升层）仍按各层原始 result_count，不受展示层去重影响。
