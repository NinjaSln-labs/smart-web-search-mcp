# 安装 / Install

## 系统要求

- **Python ≥ 3.10**（安装器与包管理；运行时零第三方依赖）
- **Node ≥ 22.7**（MCP server 核心：TS strip-only 直跑，免 esbuild / 免打包）
- 可选：`npm i -g wigolo`（L1 免费搜索源；缺失时自动降级到其它层）

## 安装

```bash
# 推荐：uv tool（隔离环境，不污染系统 Python）
uv tool install smart-web-search-mcp

# 或 pipx
pipx install smart-web-search-mcp

# 或 pip
pip install smart-web-search-mcp
```

安装后得到两个命令：

- `smart-web-search-mcp` — MCP stdio server（各 agent 的 MCP 配置引用它）
- `smart-web-search-install` — 一键安装器

## 一键接入 agent

```bash
smart-web-search-install --list      # 探测本机已装的 agent（只读）
smart-web-search-install --dry-run   # 预览将写入的内容（不落盘）
smart-web-search-install             # 写入所有检测到的 agent（幂等）
smart-web-search-install --force     # 覆盖已存在条目（覆盖前备份 .bak）
smart-web-search-install --agents pi,cline,dsh   # 只装指定几家
```

支持 10 家：pi（≥0.99.0 内置 MCP，旧扩展自动迁移）/ Cursor / Cline / opencode / zcode / Qoder CLI / mcode（MiniMax Code）/ commandcode / dsh / reasonix。未安装的自动跳过。

## 手动配置（任意支持 stdio MCP 的客户端）

```json
{ "mcpServers": { "smart-web-search": { "command": "smart-web-search-mcp", "args": [] } } }
```

不用安装器也可直接以 node 跑包内入口：

```
command: node
args:    [ <site-packages>/smart_web_search_mcp/smart-web-search-mcp-server.mjs ]
```

## 凭据配置（全部可选）

不配任何 key 时 L1 wigolo 即开箱可用。各 provider 的 key 来源（按优先级）：

1. **环境变量**：`TINYFISH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` / `KEENABLE_API_KEY`
2. **配置文件** `~/.pi/agent/extensions/smart-web-search-mcp.config.json`（安装器不改它）：

```json
{
  "tinyfish": { "key": "tf-..." },
  "tavily":   { "enabled": true, "key": "tvly-..." },
  "serper":   { "enabled": true, "key": "..." },
  "keenable": { "enabled": true, "key": "..." }
}
```

opt-in 语义：tinyfish 有 key 即用（opt-out 型）；tavily / serper / keenable 必须显式 `enabled:true` 或提供 key（有配额/计费，避免新装即烧）。keenable 无 key 时走共享公共层（1K 次/小时，429 自动节流 60s）。

## 卸载

```bash
uv tool uninstall smart-web-search-mcp
```

各 agent 配置里的条目如需清理，手动删除对应 `mcpServers` 条目即可。
