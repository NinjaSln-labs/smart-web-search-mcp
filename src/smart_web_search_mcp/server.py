"""smart-web-search-mcp —— 以 node 运行 MCP stdio server。

各家 agent 的 MCP 配置只引用稳定的命令名 `smart-web-search-mcp`（而非 venv 内部绝对路径），
由本入口把 stdin/stdout 原样交给 server.mjs（node ≥22.7）。

server 入口解析顺序：
  1. 环境变量 SMART_WEB_SEARCH_SERVER 显式指定；
  2. 真源仓库路径 ~/ninjasin-labs/agent-tools/smart-web-search/（存在时优先——真源机改核心 .ts 即时生效）；
  3. 包内置副本（wheel 自带，供无仓库的机器独立运行）。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

_SERVER_NAME = "smart-web-search-mcp-server.mjs"


def _find_server() -> Path | None:
    env = os.environ.get("SMART_WEB_SEARCH_SERVER")
    if env:
        p = Path(env).expanduser()
        return p if p.is_file() else None
    candidates = [
        Path.home() / "ninjasin-labs" / "agent-tools" / "smart-web-search" / _SERVER_NAME,  # 真源仓
        Path(__file__).resolve().parent / _SERVER_NAME,                                        # 包内副本
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def main() -> int:
    mjs = _find_server()
    if mjs is None:
        sys.stderr.write(
            "smart-web-search-mcp: 找不到 server（设 SMART_WEB_SEARCH_SERVER=<绝对路径>，"
            "或把真源仓放在 ~/ninjasin-labs/agent-tools/smart-web-search/）\n"
        )
        return 1
    node = shutil.which("node")
    if not node:
        sys.stderr.write("smart-web-search-mcp: PATH 中找不到 node（需 Node >= 22.7）\n")
        return 1
    os.execv(node, [node, str(mjs), *sys.argv[1:]])
    return 0  # 不会到达（execv 成功即替换进程）


if __name__ == "__main__":
    sys.exit(main())
