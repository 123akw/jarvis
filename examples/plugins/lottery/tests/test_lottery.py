"""抽签分组插件测试：直接测工具函数，不需要模型。"""
import importlib.util
import json
import re
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))


def _load_tools():
    spec = importlib.util.spec_from_file_location(f"plugin_{MANIFEST['id']}_tools", PLUGIN_DIR / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = _load_tools()
CLASS = "张三、李四、王五、赵六、钱七、孙八、周九、吴十、郑十一、冯十二"


def _body(text):
    """去掉末尾抽签码那行，只比结果本身。"""
    return text.rsplit("\n抽签码：", 1)[0]


def test_manifest_matches_exports():
    assert re.fullmatch(r"[a-z][a-z0-9_]{1,30}", MANIFEST["id"])
    assert [t.name for t in tools.TOOLS] == MANIFEST["tools"]
    assert all(t.name.startswith(MANIFEST["id"]) and t.description.strip() for t in tools.TOOLS)


def test_parse_names_separators_and_dups():
    assert tools.parse_names("张三，李四、王五\n赵六;钱七") == (["张三", "李四", "王五", "赵六", "钱七"], [])
    assert tools.parse_names("Li Lei, Han Meimei") == (["Li Lei", "Han Meimei"], [])
    assert tools.parse_names("甲 乙 丙 甲") == (["甲", "乙", "丙"], ["甲"])


def test_groups_balanced_and_complete():
    out = tools.make_groups(CLASS, group_count=3, seed="班会")
    sizes = [int(n) for n in re.findall(r"第 \d 组（(\d+) 人）", out)]
    assert sorted(sizes) == [3, 3, 4]
    members = re.findall(r"组（\d+ 人）：(.+)", out)
    assert sorted("、".join(members).split("、")) == sorted(CLASS.split("、"))
    assert "抽签码：班会" in out


def test_group_size_mode():
    out = tools.make_groups(CLASS, group_size=4, seed="x")
    assert "分成 3 组" in out


def test_same_seed_same_result_different_seed_differs():
    first = tools.make_groups(CLASS, group_count=2, seed="abc")
    assert tools.make_groups(CLASS, group_count=2, seed="abc") == first
    others = {_body(tools.make_groups(CLASS, group_count=2, seed=f"s{i}")) for i in range(5)}
    assert len(others) > 1


def test_random_seed_is_reported_and_reproducible():
    out = tools.draw(CLASS, 2)
    seed = re.search(r"抽签码：(\w+)", out).group(1)
    assert tools.draw(CLASS, 2, seed=seed) == out


def test_draw_without_replacement():
    out = tools.draw(CLASS, 10, seed="all")
    picked = re.findall(r"^\d+\. (.+)$", out, flags=re.M)
    assert sorted(picked) == sorted(CLASS.split("、"))


def test_rota_skips_weekends_and_rotates():
    out = tools.rota("甲、乙、丙", "2026-10-09", days=4, per_day=1, skip_weekends=True, seed="r")
    days = re.findall(r"^(\d+月\d+日) 周(.)：(.+)$", out, flags=re.M)
    assert [d[0] for d in days] == ["10月9日", "10月12日", "10月13日", "10月14日"]
    assert all(w not in "六日" for _, w, _ in days)
    people = [p for *_, p in days]
    assert len(set(people[:3])) == 3 and people[3] == people[0]   # 三人轮一圈后回到第一个


def test_friendly_errors():
    assert "至少要有 2 个名字" in tools.make_groups("张三")
    assert "抽不出 5 个" in tools.draw("甲、乙", 5)
    assert "看不懂" in tools.rota("甲、乙", "下周一")
    assert "每天值日人数" in tools.rota("甲、乙", "2026-10-08", per_day=3)


def test_tool_invoke():
    out = tools.lottery_draw.invoke({"names": "甲、乙、丙", "count": 1, "seed": "t"})
    assert out.startswith("从 3 人里抽中：")
