"""技能热加载：skills/<名>/SKILL.md 注入系统提示词，改文件下一轮生效。"""
import pytest
from jarvis.prompts import (MAX_SKILL_CHARS, MAX_SKILLS, compose_system_prompt,
                            load_skills, skill_sections)


@pytest.fixture()
def skills_root(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_SKILLS_DIR", str(tmp_path))
    return tmp_path


def _write(root, name, content):
    d = root / name
    d.mkdir(exist_ok=True)
    (d / "SKILL.md").write_text(content, encoding="utf-8")


def test_empty_or_missing_dir_is_silent(skills_root):
    assert load_skills() == []                      # 空目录
    assert skill_sections() == ""
    assert "附加技能" not in compose_system_prompt()
    (skills_root / "not-a-dir.txt").write_text("x")  # 散文件不算技能
    assert load_skills() == []


def test_skill_injected_into_system_prompt(skills_root):
    _write(skills_root, "lobster", "# 龙虾尾巴\n每次回答的末尾都加一个🦞。")
    prompt = compose_system_prompt()
    assert "### 技能：龙虾尾巴" in prompt
    assert "每次回答的末尾都加一个🦞。" in prompt


def test_hot_reload_without_restart(skills_root):
    _write(skills_root, "a", "# 甲\n规则一")
    assert "规则一" in compose_system_prompt()
    _write(skills_root, "a", "# 甲\n规则二")        # 改文件：下一轮生效
    prompt = compose_system_prompt()
    assert "规则二" in prompt and "规则一" not in prompt
    (skills_root / "a" / "SKILL.md").unlink()        # 删文件：技能消失
    assert "附加技能" not in compose_system_prompt()


def test_broken_and_empty_files_are_skipped(skills_root):
    _write(skills_root, "empty", "")
    _write(skills_root, "headonly", "# 只有标题没有正文")
    (skills_root / "nofile").mkdir()                 # 有目录没 SKILL.md
    _write(skills_root, "ok", "# 正常\n可用规则")
    skills = load_skills()
    assert [s["name"] for s in skills] == ["正常"]
    _write(skills_root, "noname", "#\n只有空标题的正文")  # 空标题退回目录名
    assert {"noname", "正常"} == {s["name"] for s in load_skills()}


def test_guardrails_cap_count_and_length(skills_root):
    for i in range(MAX_SKILLS + 5):
        _write(skills_root, f"s{i:02d}", f"# 技能{i}\n正文{i}")
    assert len(load_skills()) == MAX_SKILLS          # 数量上限
    _write(skills_root, "s00", "# 大\n" + "长" * (MAX_SKILL_CHARS + 500))
    big = next(s for s in load_skills() if s["name"] == "大")
    assert len(big["body"]) == MAX_SKILL_CHARS       # 单条截断
