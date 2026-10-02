# Changelog

本文件记录所有对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 SemVer。

## [Unreleased]

## [0.1.0] — 2026-10-02

### Added

- **MCP stdio server** `smart_web_search`：5-provider 融合搜索路由——L1 wigolo + keenable（免费，并行）→ L2 tinyfish → tavily（串行）→ L3 serper（无条件兜底）；每次调用返回完整 routing chain。
- **一键安装器** `smart-web-search-install`：自动探测 10 家 agent（pi / Cursor / Cline / opencode / zcode / Qoder / mcode / commandcode / dsh / reasonix），幂等写入 MCP 配置；pi 旧扩展自动迁移到内置 MCP。
- 零 Python 依赖（纯标准库）；Node ≥22.7 strip-only 直跑 TS 核心，免编译。
- keenable 公共层 429 自动节流；可配置 opt-in 的凭据解析（env / config）。
