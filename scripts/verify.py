#!/usr/bin/env python3
"""验证链单源：strip-only lint + pytest，全绿 exit 0。

用法:
  python scripts/verify.py

提交前必须全绿（pre-commit / CI / 发布 workflow 三处同源引用本文件）。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "smart-web-search-mcp.ts"
SERVER = ROOT / "smart-web-search-mcp-server.mjs"


def check_strip_only() -> int:
    """核心 .ts / mcp-server.mjs 禁用 TS parameter property / enum / namespace
    （Node strip-only 不做 TS 转换，命中即运行期炸）。"""
    import re

    status = 0
    for f in (CORE, SERVER):
        text = f.read_text(encoding="utf-8")
        if re.search(r"^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s", text, re.M):
            print(f"{f.name}: 禁用 enum")
            status = 1
        if re.search(r"^\s*(export\s+)?(declare\s+)?namespace\s", text, re.M):
            print(f"{f.name}: 禁用 namespace")
            status = 1
        if re.search(
            r"constructor\s*\(\s*(public|private|protected|readonly)\s+[\w$]+\s*\??\s*[:=]"
            r"|constructor\s*\([^)]*,\s*(public|private|protected|readonly)\s+[\w$]+\s*\??\s*[:=]",
            text,
        ):
            print(f"{f.name}: 禁用 TS parameter property（构造器参数带 public/private/protected/readonly 修饰）")
            status = 1
    if status == 0:
        print("[verify] strip-only PASS")
    return status


def main():
    failed = []
    print("[verify] strip-only ...")
    if check_strip_only() != 0:
        failed.append("strip-only")
    print("[verify] pytest ...")
    if subprocess.run([sys.executable, "-m", "pytest"]).returncode != 0:
        failed.append("pytest")
    if failed:
        print(f"[verify] FAIL: {', '.join(failed)}")
        sys.exit(1)
    print("[verify] all green")


if __name__ == "__main__":
    main()
