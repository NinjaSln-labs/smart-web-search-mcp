"""smart-web-search-install 一键安装器单元测试。

覆盖：各家配置格式合并（cline/commandcode/opencode/mcode/zcode）、cursor Windows 桥接、幂等、
--force 覆盖、.bak 备份、dry-run 不落盘、CLI 调用适配器（mock，reasonix/qoder/pi）、pi 扩展→MCP 迁移、
dsh patch 追加。用 monkeypatch 将 home() 指向 tmp_path，隔离用户真实配置。
"""

import json
import subprocess
from pathlib import Path

import pytest

from smart_web_search_mcp import agent_install as ai


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """把 home() 指向 tmp_path 下的 fake-home，并隔离 shutil.which 与 Windows home 解析。"""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(ai, "home", lambda: h)
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: False)
    monkeypatch.setattr(ai, "_windows_home", lambda: None)  # 默认无 Windows 侧
    return h


def _write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- JSON 直写类

@pytest.mark.parametrize("cls,expect_path", [
    (ai.ClineInstaller, ".cline/data/settings/cline_mcp_settings.json"),
    (ai.CommandCodeInstaller, ".commandcode/mcp.json"),
])
def test_json_mcpservers_install_and_idempotent(fake_home, cls, expect_path):
    inst = cls()
    p = fake_home / expect_path
    _write(p, {"mcpServers": {"other-server": {"command": "x"}}})

    assert inst.entry_status() == "absent"
    r1 = inst.install(force=False)
    assert "新增" in r1 and p.exists()
    data = json.loads(p.read_text(encoding="utf-8"))
    assert data["mcpServers"]["other-server"]["command"] == "x"  # 无关条目保留
    assert data["mcpServers"][ai.SERVER_NAME]["args"] == ai._server_command()[1:]

    # 幂等：重复 install 不重复加、不改内容
    before = p.read_text(encoding="utf-8")
    r2 = inst.install(force=False)
    assert "已存在" in r2
    assert p.read_text(encoding="utf-8") == before

    # --force 覆盖 + 备份
    p.write_text(json.dumps({"mcpServers": {ai.SERVER_NAME: {"command": "old"}}}), encoding="utf-8")
    r3 = inst.install(force=True)
    assert "覆盖" in r3
    data = json.loads(p.read_text(encoding="utf-8"))
    assert data["mcpServers"][ai.SERVER_NAME]["command"] == ai.SERVER_CMD
    assert p.with_name(p.name + ".bak").exists()  # 备份生成


def test_opencode_uses_cli(fake_home, monkeypatch):
    """opencode：走官方 CLI（自管 jsonc 保留注释），不 JSON 直写。"""
    inst = ai.OpenCodeInstaller()
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: True)
    runs = []

    def fake_run(args, timeout):
        runs.append(args)
        return subprocess.CompletedProcess(args, 0, stdout="" if "list" in args else "added", stderr="")

    monkeypatch.setattr(ai, "_run", fake_run)
    assert "已通过" in inst.install(force=False)
    assert runs[-1] == ["opencode", "mcp", "add", "--global", ai.SERVER_NAME, "--", ai.SERVER_CMD]


def test_zcode_servers_key_not_mcpservers(fake_home):
    """zcode 用 mcp.servers（不是 mcpServers）——键名错误会写进错误位置。"""
    inst = ai.ZCodeInstaller()
    p = fake_home / ".zcode" / "cli" / "config.json"
    _write(p, {"model": {"main": "tokenrouter/z-ai/glm-5.3-free"}, "mcp": {"servers": {}}})

    inst.install(force=False)
    data = json.loads(p.read_text(encoding="utf-8"))
    assert ai.SERVER_NAME in data["mcp"]["servers"]
    assert ai.SERVER_NAME not in data  # 不落在顶层
    assert data["model"]["main"] == "tokenrouter/z-ai/glm-5.3-free"  # 无关段保留
    assert data["mcp"]["servers"][ai.SERVER_NAME]["enable"] is True


def test_json_parse_error_skips_without_destroying(fake_home):
    """损坏/含注释 JSON 解析失败 → 跳过并保留原文件（JSON 直写类）。"""
    inst = ai.CommandCodeInstaller()
    p = fake_home / ".commandcode" / "mcp.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{ // jsonc comment\n  "mcpServers": {}\n}', encoding="utf-8")
    before = p.read_text(encoding="utf-8")

    r = inst.install(force=False)
    assert "跳过" in r
    assert p.read_text(encoding="utf-8") == before  # 原文件未被破坏


def test_json_missing_file_creates(fake_home):
    inst = ai.CommandCodeInstaller()
    r = inst.install(force=False)
    assert "新增" in r
    assert inst.entry_status() == "exists"


def test_mcode_mcpservers_stdio(fake_home):
    """mcode：~/.minimax/mcp.json 的 mcpServers，stdio 条目含 type/enabled。"""
    inst = ai.McodeInstaller()
    p = fake_home / ".minimax" / "mcp.json"
    _write(p, {"mcpServers": {"other": {"type": "stdio", "command": "x"}}})

    assert inst.entry_status() == "absent"
    r = inst.install(force=False)
    assert "新增" in r
    data = json.loads(p.read_text(encoding="utf-8"))
    s = data["mcpServers"][ai.SERVER_NAME]
    assert s["type"] == "stdio"
    assert s["command"] == ai.SERVER_CMD
    assert s["args"] == []
    assert s["enabled"] is True
    assert data["mcpServers"]["other"]["command"] == "x"  # 无关条目保留

    assert "已存在" in inst.install(force=False)  # 幂等


def test_cursor_windows_bridge(fake_home, tmp_path, monkeypatch):
    """cursor：写 Windows home 的 .cursor/mcp.json，command=wsl.exe 桥接 WSL server。"""
    win = tmp_path / "winhome"
    (win / ".cursor").mkdir(parents=True)
    monkeypatch.setattr(ai, "_windows_home", lambda: win)

    inst = ai.CursorInstaller()
    assert inst.detect() is True
    r = inst.install(force=False)
    assert "新增" in r
    p = win / ".cursor" / "mcp.json"
    entry = json.loads(p.read_text(encoding="utf-8"))["mcpServers"][ai.SERVER_NAME]
    assert entry["command"] == "wsl.exe"
    assert entry["args"] == ["-e", "bash", "-lc", f"exec {ai.SERVER_CMD}"]  # 经 WSL 桥跑稳定命令


def test_cursor_absent_when_no_windows_home(fake_home):
    inst = ai.CursorInstaller()
    assert inst.detect() is False
    assert "跳过" in inst.install(force=False)


# ---------------------------------------------------------------- 文件 patch 类

def test_dsh_patch_append_and_idempotent(fake_home):
    inst = ai.DshInstaller()
    prof = fake_home / ".dsh" / "profiles" / "headless"
    prof.mkdir(parents=True)
    patch = prof / "cordis.patch.yml"
    patch.write_text("- id: existing-entry\n", encoding="utf-8")

    r1 = inst.install(force=False)
    assert "headless" in r1
    txt = patch.read_text(encoding="utf-8")
    assert ai.DshInstaller.entry_id in txt
    assert "existing-entry" in txt  # 原有条目保留
    assert ai.SERVER_CMD in txt

    # 幂等：重复跑不重复追加
    n1 = txt.count(ai.DshInstaller.entry_id)
    inst.install(force=False)
    n2 = patch.read_text(encoding="utf-8").count(ai.DshInstaller.entry_id)
    assert n1 == n2 == 1

    # --force 仍只保留一条（替换而非重复追加）
    inst.install(force=True)
    assert patch.read_text(encoding="utf-8").count(ai.DshInstaller.entry_id) == 1


def test_dsh_no_profile_skips(fake_home):
    r = ai.DshInstaller().install(force=False)
    assert "跳过" in r


def test_dsh_plugin_spec_pins_dsh_version(fake_home, monkeypatch):
    """dsh 插件版本与 dsh 版本对齐（不匹配会被 peer 校验拒绝）。"""
    inst = ai.DshInstaller()
    monkeypatch.setattr(ai, "_dsh_version", lambda: "0.2.0-rc.2")
    assert inst._plugin_spec() == "@deepseek-ai/dsh-mcp-client@0.2.0-rc.2"
    monkeypatch.setattr(ai, "_dsh_version", lambda: None)
    assert inst._plugin_spec() == "@deepseek-ai/dsh-mcp-client"


# ---------------------------------------------------------------- CLI 调用类

def test_cli_installer_calls_cli(fake_home, monkeypatch):
    inst = ai.ReasonixInstaller()
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: True)
    calls = {}

    def fake_run(args, timeout):
        calls["args"] = args
        return subprocess.CompletedProcess(args, 0, stdout="added MCP server", stderr="")

    monkeypatch.setattr(ai, "_run", fake_run)
    r = inst.install(force=False)
    assert "added MCP server" in r
    assert calls["args"] == ["reasonix", "mcp", "add", ai.SERVER_NAME, "--", *ai._server_command()]


def test_cli_installer_skips_when_exists(fake_home, monkeypatch):
    inst = ai.QoderInstaller()
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: True)
    monkeypatch.setattr(ai, "_run",
                        lambda args, timeout: subprocess.CompletedProcess(args, 0, stdout=ai.SERVER_NAME, stderr=""))
    r = inst.install(force=False)
    assert "已存在" in r


def test_cli_installer_force_removes_then_adds(fake_home, monkeypatch):
    """--force 覆盖时先 remove 再 add（CLI 的 add 遇同名会报错）。"""
    inst = ai.QoderInstaller()
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: True)
    runs = []

    def fake_run(args, timeout):
        runs.append(args)
        return subprocess.CompletedProcess(args, 0, stdout=ai.SERVER_NAME, stderr="")

    monkeypatch.setattr(ai, "_run", fake_run)
    r = inst.install(force=True)
    assert "已通过" in r
    assert ["qodercn", "mcp", "remove", "-s", "user", ai.SERVER_NAME] in runs
    assert runs[-1] == ["qodercn", "mcp", "add", "-s", "user", ai.SERVER_NAME, "--", ai.SERVER_CMD]


def test_pi_mcp_cli_installer(fake_home, monkeypatch):
    """pi 新版内置 MCP：走 `pi mcp add`（不再是扩展 copy）。"""
    inst = ai.PiInstaller()
    monkeypatch.setattr(ai, "_cli_exists", lambda *names: True)
    runs = []

    def fake_run(args, timeout):
        runs.append(args)
        out = "" if "list" in args else "added smart-web-search"
        return subprocess.CompletedProcess(args, 0, stdout=out, stderr="")

    monkeypatch.setattr(ai, "_run", fake_run)
    r = inst.install(force=False)
    assert "added smart-web-search" in r
    assert runs[-1] == ["pi", "mcp", "add", ai.SERVER_NAME, "--", *ai._server_command()]

    monkeypatch.setattr(ai, "_run",
                        lambda args, timeout: subprocess.CompletedProcess(args, 0, stdout=ai.SERVER_NAME, stderr=""))
    assert inst.entry_status() == "exists"


def test_pi_migrates_legacy_extension(fake_home, monkeypatch):
    """旧扩展安装 → install 先备份并移除扩展，再走 pi mcp add（扩展→MCP 迁移）。"""
    inst = ai.PiInstaller()
    ext = fake_home / ".pi" / "agent" / "extensions" / ai.PI_LEGACY_EXT
    ext.parent.mkdir(parents=True)
    ext.write_text("// legacy extension\n", encoding="utf-8")

    # 隔离真实 `pi mcp list`：未迁移时列表为空
    monkeypatch.setattr(ai, "_run",
                        lambda args, timeout: subprocess.CompletedProcess(
                            args, 0, stdout="" if "list" in args else "added smart-web-search", stderr=""))

    assert inst.detect() is True  # 仅凭旧扩展即可检测到 pi
    assert inst.entry_status() == "legacy"
    r = inst.install(force=False)
    assert not ext.exists()  # 扩展已移除
    assert ext.with_name(ext.name + ".bak").read_text(encoding="utf-8") == "// legacy extension\n"
    assert "已卸载旧扩展" in r and "added smart-web-search" in r


# ---------------------------------------------------------------- main() 流程

def test_main_list_and_dry_run(fake_home, capsys):
    assert ai.main(["--list"]) == 0
    assert "未检测到" in capsys.readouterr().out

    assert ai.main(["--dry-run"]) == 0


def test_main_installs_detected_only(fake_home):
    # 模拟只安装了 cline + commandcode
    _write(fake_home / ".cline" / "data" / "settings" / "cline_mcp_settings.json", {"mcpServers": {}})
    _write(fake_home / ".commandcode" / "mcp.json", {"mcpServers": {}})

    assert ai.main([]) == 0
    for rel in (".cline/data/settings/cline_mcp_settings.json", ".commandcode/mcp.json"):
        data = json.loads((fake_home / rel).read_text(encoding="utf-8"))
        assert ai.SERVER_NAME in data["mcpServers"]
        assert data["mcpServers"][ai.SERVER_NAME]["args"] == ai._server_command()[1:]
    # 未安装的（如 opencode）不应被创建
    assert not (fake_home / ".config" / "opencode").exists()


def test_main_agents_subset(fake_home):
    _write(fake_home / ".commandcode" / "mcp.json", {"mcpServers": {}})
    assert ai.main(["--agents", "commandcode"]) == 0
    data = json.loads((fake_home / ".commandcode" / "mcp.json").read_text(encoding="utf-8"))
    assert ai.SERVER_NAME in data["mcpServers"]
