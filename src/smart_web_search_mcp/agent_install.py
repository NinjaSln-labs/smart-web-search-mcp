"""一键安装 smart-web-search MCP 配置到本机已装的 AI agent CLI（零依赖，Python 标准库）。

设计（镜像姊妹工具 docs-search 的 docs-search-install）：
- 每家一个适配器（detect 检测是否已安装 / entry_status 查条目 / install 幂等写入）
- 写入方式分三类：
    JSON 直写（cline/opencode/mcode/commandcode/zcode——mcpServers 或 mcp.servers 映射合并）
    CLI 调用（reasonix/qoder/pi——官方 CLI 管理 MCP，配置格式交给官方）
    文件 patch（dsh——cordis.patch.yml insert 行追加）
    Windows 桥接（cursor——写 %USERPROFILE%\\.cursor\\mcp.json，经 wsl.exe 跑 WSL 里的 server）
- 幂等：目标条目已存在时跳过（--force 覆盖）；覆盖前备份原文件（<file>.bak）
- 安全：不触碰无关配置段；JSON 解析失败（如 opencode.jsonc 含注释）跳过该家并保留原文件

pi 迁移：新版 pi（>=0.99.0）内置 MCP，走 `pi mcp add` 写 ~/.pi/agent/mcp.json；
若存在旧版扩展安装位 ~/.pi/agent/extensions/smart-web-search-mcp.ts，安装时先备份(.bak)并移除，
再执行 `pi mcp add`——即「扩展 → MCP」的迁移，避免扩展与 MCP 重复注册工具。

启动命令：`smart-web-search-mcp`（稳定的 console 入口，内部以 node 跑内置的
smart-web-search-mcp-server.mjs；纯 stdio，spawn-per-call）。
凭据走 env/vault 单源（SERPER/TINYFISH/TAVILY/KEENABLE_API_KEY），不在各客户端重复配置。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SERVER_NAME = "smart-web-search"
PI_LEGACY_EXT = "smart-web-search-mcp.ts"  # 旧版 pi 扩展安装位：~/.pi/agent/extensions/

# 检测用 CLI 命令（配置名与官方入口一致；Windows 下 cmd 别名撞系统 cmd.exe，故 Command Code 用 commandcode）
AGENTS = [
    "pi",
    "cursor",
    "cline",
    "opencode",
    "mcode",
    "commandcode",
    "zcode",
    "reasonix",
    "qoder",
    "dsh",
]

AGENT_NAMES_ZH = {
    "pi": "pi（内置 MCP）",
    "cursor": "Cursor",
    "cline": "Cline",
    "opencode": "OpenCode",
    "mcode": "MiniMax Code（mcode）",
    "commandcode": "Command Code",
    "zcode": "ZCode",
    "reasonix": "Reasonix",
    "qoder": "Qoder（qodercn）",
    "dsh": "DSH",
}


def home() -> Path:
    return Path(os.path.expanduser("~"))


def _cli_exists(*names: str) -> bool:
    return any(shutil.which(n) for n in names)


def _run(args: list[str], timeout: int):
    """subprocess 包装：Windows 下 npm shim（.cmd）需经 cmd.exe 执行，参数用 list2cmdline 保持引号语义。"""
    if os.name == "nt" and shutil.which(args[0]):
        exe = shutil.which(args[0])
        if exe.lower().endswith((".cmd", ".bat")):
            cmdline = subprocess.list2cmdline(args)
            return subprocess.run(
                [os.environ.get("COMSPEC", "cmd.exe"), "/c", cmdline],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def _json_read(path: Path):
    """读 JSON；失败抛 ValueError（含原因）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path}: JSON 解析失败（{e}）——跳过，避免破坏现有配置") from e


def _json_write(path: Path, data) -> None:
    """写 JSON（先备份原文件为 .bak，保持缩进 2）。"""
    if path.exists():
        bak = path.with_name(path.name + ".bak")
        if not bak.exists():
            shutil.copy2(path, bak)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


SERVER_CMD = "smart-web-search-mcp"  # console 入口（server.py），稳定命令名而非 venv 内部路径


def _server_command() -> list[str]:
    """MCP server 启动命令（客户端配置的 command + args）。"""
    return [SERVER_CMD]


def _server_command_abs() -> list[str]:
    """绝对路径版（供 PATH 受限的宿主，如 dsh/systemd）；解析不到则退回命令名。"""
    return [shutil.which(SERVER_CMD) or SERVER_CMD]


def _windows_home() -> Path | None:
    """定位 Windows 用户目录：Windows 下取 %USERPROFILE%；WSL 下扫描 /mnt/c/Users（优先含 .cursor 的）。"""
    if os.name == "nt":
        up = os.environ.get("USERPROFILE")
        return Path(up) if up else None
    users = Path("/mnt/c/Users")
    if not users.is_dir():
        return None
    with_cursor = sorted(p for p in users.iterdir() if (p / ".cursor").is_dir())
    if with_cursor:
        return with_cursor[0]
    skip = {"All Users", "Default", "Default User", "Public"}
    real = [p for p in users.iterdir() if p.is_dir() and p.name not in skip]
    return real[0] if len(real) == 1 else None


def _dsh_version() -> str | None:
    """dsh 版本号（dsh-plugin 版本与之对齐，如 dsh 0.2.0-rc.2 ↔ dsh-mcp-client 0.2.0-rc.2）；取不到返回 None。"""
    if not _cli_exists("dsh"):
        return None
    try:
        out = _run(["dsh", "--version"], timeout=30).stdout or ""
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"\d+\.\d+\.\d+(?:-[\w.]+)?", out)
    return m.group(0) if m else None


class BaseInstaller:
    """适配器基类：name/describe/detect/entry_status/install。"""

    name = ""
    kind = ""

    def describe(self) -> str:
        raise NotImplementedError

    def detect(self) -> bool:
        raise NotImplementedError

    def entry_status(self) -> str:
        """返回 "absent" | "exists"（目标条目是否已配置）。"""
        raise NotImplementedError

    def install(self, force: bool) -> str:
        """写入配置。返回人类可读结果描述。"""
        raise NotImplementedError


# ---------------------------------------------------------------- JSON 直写类

class JsonMapInstaller(BaseInstaller):
    """mcpServers 风格（cline/commandcode）：顶层 mcpServers 映射。"""

    kind = "json"
    server_key = "mcpServers"

    @property
    def config_path(self) -> Path:
        raise NotImplementedError

    def describe(self) -> str:
        return f"{self.name}：{self.config_path}（{self.server_key}）"

    def detect(self) -> bool:
        return self.config_path.parent.exists() if self.config_path else False

    def entry_status(self) -> str:
        p = self.config_path
        if not p.exists():
            return "absent"
        try:
            data = _json_read(p)
        except ValueError:
            return "absent"
        servers = data.get(self.server_key, {}) if isinstance(data, dict) else {}
        return "exists" if SERVER_NAME in servers else "absent"

    def _entry(self) -> dict:
        cmd = _server_command()
        return {"command": cmd[0], "args": cmd[1:], "env": {}}

    def install(self, force: bool) -> str:
        p = self.config_path
        if p.exists():
            try:
                data = _json_read(p)
            except ValueError as e:
                return f"跳过：{e}"
        else:
            data = {}
        servers = data.setdefault(self.server_key, {})
        if SERVER_NAME in servers and not force:
            return f"已存在 {SERVER_NAME} 条目（--force 覆盖）"
        servers[SERVER_NAME] = self._entry()
        _json_write(p, data)
        return f"已写入 {p}（{'覆盖' if force else '新增'} {SERVER_NAME}）"


class ClineInstaller(JsonMapInstaller):
    name = "cline"

    @property
    def config_path(self) -> Path:
        return home() / ".cline" / "data" / "settings" / "cline_mcp_settings.json"

    def describe(self) -> str:
        return "Cline：~/.cline/data/settings/cline_mcp_settings.json（mcpServers，CLI 实际读取路径）"


class CommandCodeInstaller(JsonMapInstaller):
    name = "commandcode"

    @property
    def config_path(self) -> Path:
        return home() / ".commandcode" / "mcp.json"

    def describe(self) -> str:
        return "Command Code：~/.commandcode/mcp.json（user-scope mcpServers）"


class McodeInstaller(JsonMapInstaller):
    """MiniMax Code（mcode）：~/.minimax/mcp.json 的 mcpServers 映射（stdio 条目含 type/enabled）。"""

    name = "mcode"

    @property
    def config_path(self) -> Path:
        return home() / ".minimax" / "mcp.json"

    def describe(self) -> str:
        return "MiniMax Code：~/.minimax/mcp.json（mcpServers，stdio）"

    def detect(self) -> bool:
        return _cli_exists("mcode") or self.config_path.parent.exists()

    def _entry(self) -> dict:
        cmd = _server_command()
        return {"type": "stdio", "command": cmd[0], "args": cmd[1:], "env": {}, "enabled": True}


class ZCodeInstaller(JsonMapInstaller):
    """ZCode CLI：mcp.servers 键（注意不是 mcpServers），与 provider/model 同文件。"""

    name = "zcode"

    @property
    def config_path(self) -> Path:
        return home() / ".zcode" / "cli" / "config.json"

    def describe(self) -> str:
        return "ZCode：~/.zcode/cli/config.json（mcp.servers）"

    def detect(self) -> bool:
        return self.config_path.exists() or home().joinpath(".zcode", "cli").exists()

    def _mcp(self, data):
        mcp = data.get("mcp", {}) if isinstance(data, dict) else {}
        return mcp.get("servers", {}) if isinstance(mcp, dict) else {}

    def entry_status(self) -> str:
        p = self.config_path
        if not p.exists():
            return "absent"
        try:
            data = _json_read(p)
        except ValueError:
            return "absent"
        return "exists" if SERVER_NAME in self._mcp(data) else "absent"

    def install(self, force: bool) -> str:
        p = self.config_path
        if p.exists():
            try:
                data = _json_read(p)
            except ValueError as e:
                return f"跳过：{e}"
        else:
            data = {}
        servers = data.setdefault("mcp", {}).setdefault("servers", {})
        if SERVER_NAME in servers and not force:
            return f"已存在 {SERVER_NAME} 条目（--force 覆盖）"
        cmd = _server_command()
        servers[SERVER_NAME] = {"command": cmd[0], "args": cmd[1:], "enable": True}
        _json_write(p, data)
        return f"已写入 {p}（{'覆盖' if force else '新增'} {SERVER_NAME}）"


class CursorInstaller(BaseInstaller):
    """Cursor：写 Windows 侧 %USERPROFILE%\\.cursor\\mcp.json，经 wsl.exe 桥接 WSL 里的 server。

    本机 Cursor 跑在 Windows，配置在 Windows 用户目录（WSL 侧 ~/.cursor/mcp.json 不生效）。
    """

    name = "cursor"
    kind = "json-win"

    def _path(self) -> Path | None:
        h = _windows_home()
        return (h / ".cursor" / "mcp.json") if h else None

    def describe(self) -> str:
        return "Cursor：<Windows home>\\.cursor\\mcp.json（wsl.exe 桥接 WSL server）"

    def detect(self) -> bool:
        p = self._path()
        return bool(p and p.parent.exists())

    def entry_status(self) -> str:
        p = self._path()
        if not p or not p.exists():
            return "absent"
        try:
            data = _json_read(p)
        except ValueError:
            return "absent"
        servers = data.get("mcpServers", {}) if isinstance(data, dict) else {}
        return "exists" if SERVER_NAME in servers else "absent"

    def install(self, force: bool) -> str:
        p = self._path()
        if p is None:
            return "跳过：无法定位 Windows 用户目录（%USERPROFILE%）"
        if p.exists():
            try:
                data = _json_read(p)
            except ValueError as e:
                return f"跳过：{e}"
        else:
            data = {}
        servers = data.setdefault("mcpServers", {})
        if SERVER_NAME in servers and not force:
            return f"已存在 {SERVER_NAME} 条目（--force 覆盖）"
        (exe,) = _server_command()
        servers[SERVER_NAME] = {
            "command": "wsl.exe",
            "args": ["-e", "bash", "-lc", f"exec {exe}"],
        }
        _json_write(p, data)
        return f"已写入 {p}（{'覆盖' if force else '新增'} {SERVER_NAME}，wsl.exe 桥接）"


# ---------------------------------------------------------------- CLI 调用类

class CliInstaller(BaseInstaller):
    """调用官方 CLI 管理 MCP（reasonix/qoder/pi）——配置格式交给官方，避免手工 JSON 漂移。"""

    kind = "cli"
    cli = ""
    cli_alt = None
    list_args: tuple[str, ...] = ()
    add_args: tuple[str, ...] = ()
    remove_args: tuple[str, ...] = ()
    check_needle = SERVER_NAME

    def detect(self) -> bool:
        return _cli_exists(self.cli, self.cli_alt) if self.cli_alt else _cli_exists(self.cli)

    def entry_status(self) -> str:
        if not self.detect():
            return "absent"
        try:
            out = _run([self.cli, *self.list_args], timeout=60).stdout
        except Exception:  # noqa: BLE001 -- CLI 异常按未检测处理
            return "absent"
        return "exists" if self.check_needle in out else "absent"

    def install(self, force: bool) -> str:
        cmd = _server_command()
        exists = self.entry_status() == "exists"
        if exists and not force:
            return f"已存在 {SERVER_NAME} 条目（--force 覆盖）"
        if exists and force and self.remove_args:
            # CLI 的 add 遇到同名条目会报错——--force 覆盖时先 best-effort 删除
            try:
                _run([self.cli, *self.remove_args, SERVER_NAME], timeout=60)
            except Exception:  # noqa: BLE001
                pass
        try:
            r = _run([self.cli, *self.add_args, SERVER_NAME, "--", *cmd], timeout=120)
        except FileNotFoundError:
            return f"跳过：找不到 CLI {self.cli}"
        if r.returncode != 0:
            return f"CLI 失败（exit {r.returncode}）：{(r.stderr or r.stdout).strip()[:200]}"
        return f"已通过 {self.cli} 注册（{r.stdout.strip()[:80]}）"


class ReasonixInstaller(CliInstaller):
    name = "reasonix"
    cli = "reasonix"
    list_args = ("mcp", "list")
    add_args = ("mcp", "add")
    remove_args = ("mcp", "remove")

    def describe(self) -> str:
        return "Reasonix：reasonix mcp add（全局 config.toml）"


class QoderInstaller(CliInstaller):
    name = "qoder"
    cli = "qodercn"
    cli_alt = "qoder"
    list_args = ("mcp", "list")
    add_args = ("mcp", "add", "-s", "user")
    remove_args = ("mcp", "remove", "-s", "user")

    def describe(self) -> str:
        return "Qoder：qodercn mcp add -s user（中国版额度在 qodercn，国际版 qoder 独立账号）"


class OpenCodeInstaller(CliInstaller):
    """OpenCode：走官方 `opencode mcp add --global`（自管 ~/.config/opencode/opencode.jsonc，保留注释）。

    不用 JSON 直写：opencode.jsonc 常含注释，json 解析会失败；官方 CLI 能原地保留格式写入。
    """

    name = "opencode"
    cli = "opencode"
    list_args = ("mcp", "list")
    add_args = ("mcp", "add", "--global")

    def describe(self) -> str:
        return "OpenCode：opencode mcp add --global（写 ~/.config/opencode/opencode.jsonc，保留注释）"


class PiInstaller(CliInstaller):
    """pi：新版内置 MCP，走官方 `pi mcp add`（写入 ~/.pi/agent/mcp.json）。

    兼容旧版扩展安装：若存在 `~/.pi/agent/extensions/smart-web-search-mcp.ts`，安装时先备份并移除该扩展
    （避免与 MCP 条目重复注册工具），再执行 `pi mcp add`——即扩展 → MCP 的迁移。
    """

    name = "pi"
    cli = "pi"
    list_args = ("mcp", "list")
    add_args = ("mcp", "add")

    def describe(self) -> str:
        return "pi：pi mcp add（~/.pi/agent/mcp.json，内置 MCP；旧扩展自动迁移）"

    def _legacy_ext(self) -> Path:
        return home() / ".pi" / "agent" / "extensions" / PI_LEGACY_EXT

    def detect(self) -> bool:
        return _cli_exists(self.cli) or self._legacy_ext().exists()

    def entry_status(self) -> str:
        status = super().entry_status()
        if status != "exists" and self._legacy_ext().exists():
            return "legacy"  # 旧扩展待迁移
        return status

    def install(self, force: bool) -> str:
        ext = self._legacy_ext()
        migrated = ""
        if ext.exists():
            bak = ext.with_name(ext.name + ".bak")
            if not bak.exists():
                shutil.copy2(ext, bak)
            ext.unlink()
            migrated = f"；已卸载旧扩展 {ext}（备份 {bak.name}）"
        return super().install(force) + migrated


# ---------------------------------------------------------------- 文件 patch 类

def _split_top_level_blocks(text: str) -> list[str]:
    """按顶层项（行首无缩进的 - / #）切分 YAML 文本块——用于 --force 时删除旧条目块。"""
    lines = text.splitlines()
    blocks, cur = [], []
    for l in lines:
        stripped = l.strip()
        is_top = stripped.startswith(("- ", "#")) and not l[:1].isspace()
        if is_top and cur:
            blocks.append("\n".join(cur))
            cur = [l]
        else:
            cur.append(l)
    if cur:
        blocks.append("\n".join(cur))
    return blocks


def _remove_entry_block(text: str, entry_id: str) -> str:
    """删除含 entry_id 的顶层块，其余保留（--force 覆盖用）。"""
    kept = [b for b in _split_top_level_blocks(text) if entry_id not in b]
    return "\n".join(kept).rstrip() + "\n"


class DshInstaller(BaseInstaller):
    """DSH：插件装入 profile + cordis.patch.yml insert 行追加（YAML 文本，零依赖）。"""

    name = "dsh"
    kind = "patch"
    plugin = "@deepseek-ai/dsh-mcp-client"
    entry_id = "mcp-smart-web-search"

    def _plugin_spec(self) -> str:
        """dsh-mcp-client 版本必须与 dsh 对齐（版本不匹配会被 peer 校验拒绝）。"""
        ver = _dsh_version()
        return f"{self.plugin}@{ver}" if ver else self.plugin

    def _profiles_dir(self) -> Path:
        return home() / ".dsh" / "profiles"

    def _profiles(self) -> list[str]:
        d = self._profiles_dir()
        if not d.is_dir():
            return []
        return sorted(
            p.name for p in d.iterdir()
            if p.is_dir() and not p.name.startswith(".") and p.name != "node_modules"
        )

    def describe(self) -> str:
        return "DSH：dsh plugin add + cordis.patch.yml insert 行（profile 下）"

    def detect(self) -> bool:
        return _cli_exists("dsh") or bool(self._profiles())

    def entry_status(self) -> str:
        for prof in self._profiles():
            patch = self._profiles_dir() / prof / "cordis.patch.yml"
            if patch.exists() and self.entry_id in patch.read_text(encoding="utf-8"):
                return "exists"
        return "absent"

    def install(self, force: bool) -> str:
        profiles = self._profiles()
        if not profiles:
            return "跳过：未发现 ~/.dsh/profiles/ 下的 profile（先 dsh plugin --profile <name> add）"
        cmd = _server_command_abs()
        results = []
        for prof in profiles:
            patch = self._profiles_dir() / prof / "cordis.patch.yml"
            old = patch.read_text(encoding="utf-8") if patch.exists() else ""
            exists_entry = self.entry_id in old
            if exists_entry and not force:
                results.append(f"{prof}: 已存在（--force 覆盖）")
                continue
            if _cli_exists("dsh"):
                r = _run(["dsh", "plugin", "--profile", prof, "add", self._plugin_spec()], timeout=300)
                results.append(f"{prof}: 插件 add {'OK' if r.returncode == 0 else '失败 ' + (r.stderr or '')[:120]}")
            block = (
                "\n- insert:\n"
                f"    - id: {self.entry_id}\n"
                "      name: '@deepseek-ai/dsh-mcp-client'\n"
                "      config:\n"
                f"        serverName: {SERVER_NAME}\n"
                "        transport: stdio\n"
                f"        command: {cmd[0]}\n"
                f"        args: {cmd[1:]!r}\n"
            )
            if exists_entry and force:
                old = _remove_entry_block(old, self.entry_id)
            bak = patch.with_name(patch.name + ".bak")
            if patch.exists() and not bak.exists():
                shutil.copy2(patch, bak)
            patch.parent.mkdir(parents=True, exist_ok=True)
            patch.write_text(old.rstrip() + "\n" + block, encoding="utf-8")
            results.append(f"{prof}: patch 行已写入（{'覆盖' if exists_entry and force else '新增'}）")
        return "；".join(results)


INSTALLERS: dict[str, BaseInstaller] = {c.name: c for c in [
    PiInstaller(), CursorInstaller(), ClineInstaller(), OpenCodeInstaller(),
    McodeInstaller(), CommandCodeInstaller(), ZCodeInstaller(), ReasonixInstaller(),
    QoderInstaller(), DshInstaller(),
]}


def detect_all() -> dict[str, bool]:
    return {name: inst.detect() for name, inst in INSTALLERS.items()}


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="smart-web-search-install",
        description="一键把 smart-web-search MCP server 装进本机已装的 AI agent CLI（幂等，覆盖前备份 .bak）",
    )
    p.add_argument("--agents", metavar="LIST", help="子集，逗号分隔（默认全部检测到的）")
    p.add_argument("--list", action="store_true", help="只列出检测到的 agent 与配置状态，不写入")
    p.add_argument("--dry-run", action="store_true", help="预览将要执行的写入，不落盘")
    p.add_argument("--force", action="store_true", help="覆盖已存在的条目（默认跳过）")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    detected = detect_all()

    if args.list:
        print("检测到的 agent：")
        for name in AGENTS:
            inst = INSTALLERS[name]
            mark = "✓ 已安装" if detected[name] else "✗ 未检测到"
            print(f"  {name:<12} {mark}  {inst.describe()}")
        return 0

    wanted = [a.strip() for a in args.agents.split(",")] if args.agents else AGENTS
    wanted = [a for a in wanted if a in INSTALLERS]
    if not wanted:
        print("未指定有效 agent（可用: " + ", ".join(AGENTS) + "）")
        return 2

    for name in wanted:
        inst = INSTALLERS[name]
        if not detected[name]:
            print(f"  {name:<12} 跳过：未检测到（{inst.describe()}）")
            continue
        if args.dry_run:
            status = inst.entry_status()
            action = "覆盖" if (args.force and status in ("exists", "legacy")) else ("跳过" if status == "exists" else "写入")
            print(f"  {name:<12} [dry-run] 当前条目: {status} → {action}")
            continue
        try:
            print(f"  {name:<12} {inst.install(args.force)}")
        except Exception as e:  # noqa: BLE001 -- 单家失败不阻断其他家
            print(f"  {name:<12} 出错：{e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
