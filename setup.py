"""把 MCP server 入口、其 spawn-per-call 核心、以及核心的运行期依赖 typebox 打进包。

真源仍是工具目录顶层的 `smart-web-search-mcp-server.mjs` / `smart-web-search-mcp.ts`
（server 用 `join(__dirname, "smart-web-search-mcp.ts")` 起子进程，故两者必须同目录）；
核心 `import { Type } from "typebox"`（零依赖库），需在包内 node_modules 可解析。

机制：setup() 求值前把资产**暂存**进 `src/smart_web_search_mcp/`，再用显式
package_data 清单交给 setuptools 原生处理——build_py 会复制、登记进 wheel RECORD，
sdist 也自动包含（自定义 shutil 手拷 + get_outputs 补登记的方案 bdist_wheel 不认，
实证 wheel 里会丢文件，勿回退）。暂存副本被 .gitignore 忽略（`src/.../node_modules/`
与两个构建期副本条目），真源仍是目录顶层那两份。
"""

from pathlib import Path
import shutil

from setuptools import setup

HERE = Path(__file__).resolve().parent
BUNDLE = ("smart-web-search-mcp-server.mjs", "smart-web-search-mcp.ts", "smart-web-search-mcp.config.example.json")
NODE_DEPS = ("typebox",)  # 核心运行期唯一依赖（零依赖库）
PKG = "smart_web_search_mcp"


def _find_dep(dep: str) -> Path | None:
    """向上查找 node_modules/<dep>（仓根的 node_modules 提供 typebox；sdist 树自带一份）。"""
    for base in (HERE, *HERE.parents):
        d = base / "node_modules" / dep
        if d.exists():
            return d
    return None


def _stage_assets() -> list[str]:
    """把 BUNDLE + node_modules/<dep> 暂存进包源码目录，返回 package_data 相对路径清单。
    幂等：sdist 树里真源副本只在 src/<PKG>/ 下（仓顶层不随 sdist 打包），直接沿用。
    """
    pkg_src = HERE / "src" / PKG
    pkg_src.mkdir(parents=True, exist_ok=True)
    data = []
    for name in BUNDLE:
        src = HERE / name
        if not src.is_file():
            src = pkg_src / name  # sdist 流：沿用包内已暂存副本
        if not src.is_file():
            raise SystemExit(f"setup.py: 缺少 {src}")
        if src.resolve() != (pkg_src / name).resolve():
            shutil.copy2(src, pkg_src / name)
        data.append(name)
    for dep in NODE_DEPS:
        src = _find_dep(dep)
        if src is None:
            src = pkg_src / "node_modules" / dep  # sdist 流：沿用包内已暂存副本
        if not src.exists():
            raise SystemExit(f"setup.py: 找不到 node_modules/{dep}（核心运行期依赖）")
        dst = pkg_src / "node_modules" / dep
        if dst.exists() and src.resolve() != dst.resolve():
            shutil.rmtree(dst)
        if not dst.exists():
            shutil.copytree(src, dst, symlinks=False)
        data.extend(f"node_modules/{dep}/{p.relative_to(src).as_posix()}"
                    for p in sorted(src.rglob("*")) if p.is_file())
    return data


PACKAGE_DATA = _stage_assets()

setup(package_data={PKG: PACKAGE_DATA})
