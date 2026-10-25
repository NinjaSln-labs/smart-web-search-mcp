"""smart-web-search-mcp —— 以 node 运行 MCP stdio server。

各家 agent 的 MCP 配置只引用稳定的命令名 `smart-web-search-mcp`（而非 venv 内部绝对路径），
由本入口把 stdin/stdout 原样交给 server.mjs（node ≥22.7）。

server 入口解析顺序：
  1. 环境变量 SMART_WEB_SEARCH_SERVER 显式指定（开发通道，指哪儿跑哪儿）；
  2. 包内置副本（wheel 自带）——发布包只用自己的内容，不做路径拾取式降级。
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
    bundled = Path(__file__).resolve().parent / _SERVER_NAME
    return bundled if bundled.is_file() else None


def main() -> int:
    mjs = _find_server()
    if mjs is None:
        sys.stderr.write(
            "smart-web-search-mcp: 找不到 server 入口（包内副本缺失；"
            "或设 SMART_WEB_SEARCH_SERVER=<绝对路径> 指向 smart-web-search-mcp-server.mjs）\n"
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
