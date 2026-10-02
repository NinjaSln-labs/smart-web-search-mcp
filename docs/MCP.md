# MCP 接入指南 / Agent Integration

同一份核心搜索逻辑以 **MCP stdio** 暴露（`smart-web-search-mcp` 命令）。以下配置示例均为最小可用接入；凭据走 env / 配置文件单源，无需在各客户端重复配 key（见 [INSTALL.md](INSTALL.md)）。

通用形式：

```
command: smart-web-search-mcp
args:    []
```

## pi（≥0.99.0 内置 MCP）

```bash
pi mcp add smart-web-search -- smart-web-search-mcp   # 写 ~/.pi/agent/mcp.json
pi mcp list                                            # 验证连接与工具
```

检测到旧版 pi 扩展（`~/.pi/agent/extensions/smart-web-search-mcp.ts`）时，安装器会先备份再迁移到内置 MCP，避免重复注册。

## Cursor（Windows 桌面端 + WSL server）

`%USERPROFILE%\.cursor\mcp.json`：

```json
{ "mcpServers": { "smart-web-search": { "command": "wsl.exe", "args": ["-e", "bash", "-lc", "exec smart-web-search-mcp"] } } }
```

## cline

`~/.cline/data/settings/cline_mcp_settings.json`（官方文档早先写的 `~/.cline/mcp.json` 是错的，见 cline#11671）：

```json
{ "mcpServers": { "smart-web-search": { "command": "smart-web-search-mcp", "args": [], "env": {} } } }
```

## opencode

```bash
opencode mcp add --global smart-web-search -- smart-web-search-mcp
```

写入 `~/.config/opencode/opencode.jsonc` 的 `mcp.servers`（官方 CLI 原地编辑并保留注释）。

## zcode

`~/.zcode/cli/config.json` 的 `mcp.servers`：

```json
{ "mcp": { "servers": { "smart-web-search": { "command": "smart-web-search-mcp", "enable": true } } } }
```

## Qoder CLI

```bash
qoderclicn mcp add -s user smart-web-search -- smart-web-search-mcp
qoderclicn mcp list   # 验证 Connected
```

## mcode（MiniMax Code）

`~/.minimax/mcp.json`（stdio 条目含 `type`/`enabled`，与 Cursor 同形）：

```json
{ "mcpServers": { "smart-web-search": { "type": "stdio", "command": "smart-web-search-mcp", "args": [], "env": {}, "enabled": true } } }
```

## commandcode

```bash
commandcode mcp add --transport stdio smart-web-search -- smart-web-search-mcp
```

## dsh

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client     # ① 插件装入 profile
# ② 在 ~/.dsh/profiles/<name>/cordis.patch.yml 加 insert 行：
```

```yaml
- insert:
    - id: mcp-smart-web-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: smart-web-search
        transport: stdio
        command: smart-web-search-mcp
        args: []
```

## reasonix

```bash
reasonix mcp add smart-web-search -- smart-web-search-mcp
```

## 协议兼容性说明

各客户端 MCP stdio 实现有差异，server 按输入首帧对称回包，双 framing 兼容：

- **LSP 头式**（`Content-Length: N\r\n\r\n` + N 字节 body）——cursor / zcode / opencode / commandcode 走这条
- **裸 JSON 行式**（每行一个 JSON + 换行）——reasonix 等 Rust rmcp 系客户端走这条

server 为 spawn-per-call 架构：每次 `tools/call` 独立 spawn 子进程跑一次完整搜索后退出，跨调用零状态累积，升级/重装不影响已写入的配置（各客户端只引用稳定命令名）。
