"""智能体市场的插件与职业清单（第十三轮契约 4.1；第十四轮起插件改为独立的插件包）。

插件 = 一个目录 + plugin.json（契约见 docs/proposals/2026-10-round14-plugins.md 第 1 节）：
内置插件在 ``jarvis/plugins/packs/<id>/``，Owner 导入的在 ``$JARVIS_DATA_DIR/plugins/<id>/``。
加载、校验、隔离与冲突处理都在 :mod:`jarvis.plugins.loader`；这里保持第十三轮的对外 API 不变：

- ``catalog(user_id)``：市场目录（分类 / 插件 / 职业 / 主题色），``available`` 按账号计算；
  每个插件比以前多带 ``version / author / homepage / source / builtin / status / reason``；
- ``tools_for(ids)``：一组插件对应的对话工具名，平台账号的 Agent 只绑定这些（外加 now、calc）；
- ``requirement_status(user_id)``：``feishu_bound`` / ``wechat_owner`` / ``desktop`` / ``files`` 是否满足；
- ``PLUGINS`` / ``OWNER_ONLY``：活的视图，随注册表变化（导入 / 停用后立刻反映）。

id 是对外契约（前端、流程引擎、平台存储都按 id 引用），只许加不许改。职业（PROFESSIONS）仍留在这里。
"""
from __future__ import annotations

import copy
import importlib.util
import logging
from collections.abc import Sequence, Set

from jarvis.plugins.loader import BASE_TOOLS, OWNER_TOOLS, PRO_PRICE, generation, registry, reload

log = logging.getLogger(__name__)

CATEGORIES = (
    {"id": "efficiency", "name": "效率"},
    {"id": "communication", "name": "沟通"},
    {"id": "documents", "name": "资料"},
    {"id": "info", "name": "资讯"},
    {"id": "life", "name": "生活"},
    {"id": "ai", "name": "AI 处理"},
    {"id": "output", "name": "输出"},
)

# 平台主题色：六选一，与前端主页的预设一一对应（苹果系统色，深浅色主题下都成立）
ACCENTS = (
    {"value": "#0A84FF", "name": "晴空蓝"},
    {"value": "#5E5CE6", "name": "靛紫"},
    {"value": "#30B0C7", "name": "湖青"},
    {"value": "#34C759", "name": "薄荷绿"},
    {"value": "#FF9F0A", "name": "琥珀橙"},
    {"value": "#FF375F", "name": "玫红"},
)
ACCENT_VALUES = frozenset(item["value"] for item in ACCENTS)

# 任何平台都默认带上的基础能力（不进市场）与 Owner 专属工具：BASE_TOOLS / OWNER_TOOLS（见 loader）
REQUIREMENTS = ("feishu_bound", "wechat_owner", "desktop", "files")

_ALL = ["shop_owner", "freelancer", "project_manager", "sales", "teacher", "student", "creator", "office"]
EXTRACT_TASKS = ("要点", "待办", "摘要", "周报", "改写")
SPLIT_MODES = ("chapter", "paragraph", "size")


class _PluginsView(Sequence):
    """``PLUGINS``：当前启用的插件条目（只读视图，元素是注册表里的 dict，别改它）。"""

    def _items(self) -> list[dict]:
        return registry().entries

    def __getitem__(self, index):
        return self._items()[index]

    def __len__(self) -> int:
        return len(self._items())

    def __repr__(self) -> str:
        return f"PLUGINS({[item['id'] for item in self._items()]})"


class _OwnerOnlyView(Set):
    """``OWNER_ONLY``：只有 Owner 能用的插件（微信桥只连 Owner）：推荐给其他人时一律剔除。"""

    @classmethod
    def _from_iterable(cls, it):   # 集合运算（& | -）的结果给普通 frozenset
        return frozenset(it)

    def _ids(self) -> frozenset[str]:
        return frozenset(item["id"] for item in registry().entries if "wechat_owner" in item["requires"])

    def __contains__(self, value) -> bool:
        return value in self._ids()

    def __iter__(self):
        return iter(self._ids())

    def __len__(self) -> int:
        return len(self._ids())

    def __repr__(self) -> str:
        return f"OWNER_ONLY({sorted(self._ids())})"


PLUGINS = _PluginsView()
OWNER_ONLY = _OwnerOnlyView()


def _flow(id, name, summary, *steps) -> dict:
    return {"id": id, "name": name, "summary": summary,
            "steps": [{"plugin": plugin, "options": dict(options)} for plugin, options in steps]}


def _profession(id, name, icon, summary, plugins, flows, persona, greeting, chips) -> dict:
    return {"id": id, "name": name, "icon": icon, "summary": summary, "plugins": list(plugins),
            "flows": list(flows), "persona": persona, "home": {"greeting": greeting, "chips": list(chips)}}


# 模板流程只用新账号一定能跑通的积木（不靠飞书绑定、不靠 Owner），一律以「生成网页」收尾
# 职业套餐最多 7 个插件：推荐上限 8 个（MAX_PLUGINS），留一个位置给用户描述里点名的插件；
# 第十五轮在末尾补了官方技能 / 工具插件，需要 Key 的 MCP 插件不进套餐
PROFESSIONS: tuple[dict, ...] = (
    _profession(
        "shop_owner", "个体店主 / 微商", "🏪", "进货、上新、排班和老客，小店的事都能交代",
        ("memo", "todo", "schedule", "weather", "search", "memory", "social_post"),
        (_flow("new_arrival", "上新文案", "说说新品卖点，一键写成朋友圈文案并生成网页",
               ("input_text", {"label": "说说新品是什么、卖点有哪些"}),
               ("ai_extract", {"task": "改写", "instruction": "写成适合发朋友圈的上新文案，口语化，带两三个表情"}),
               ("web_page", {"title": "今日上新"})),),
        "你是小店的经营助手：管进货、排班、上新文案和老客记录，回答直接给能落地的做法。",
        "今天店里要办的事，说一声我来记。",
        ("明天天气适合搞活动吗", "记一下：周三补货牛奶", "帮我写条上新朋友圈")),
    _profession(
        "freelancer", "自由职业者", "🧑‍💻", "接单、交付、回款，一个人也安排得明明白白",
        ("schedule", "todo", "memo", "search", "recall", "feishu", "contract_check"),
        (_flow("client_brief", "客户需求整理", "客户发来的一大段需求，拆成待办并生成清单页",
               ("input_text", {"label": "把客户发来的需求贴进来"}), ("ai_extract", {"task": "待办"}),
               ("to_todo", {}), ("web_page", {"title": "客户需求清单"})),),
        "你是自由职业者的工作助手：拆客户需求、排交付时间、记报价和回款，回答干脆、先给结论。",
        "今天要交付的活儿，一件件排给你。",
        ("今天有哪些安排", "记一下：周五前交初稿", "上次那个客户的报价是多少")),
    _profession(
        "project_manager", "项目经理", "📊", "资料、会议、进度和风险，一处看全",
        ("schedule", "todo", "meeting", "feishu", "recall", "search", "work_report"),
        (_flow("project_archive", "项目资料归档", "上传项目资料，拆分提炼要点，生成待办与网页",
               ("input_file", {}), ("split_file", {"mode": "chapter", "max_parts": 8}),
               ("ai_extract", {"task": "要点"}), ("to_todo", {}), ("web_page", {"title": "项目资料要点"})),),
        "你是项目经理的工作助手：拆任务、追进度、记会议、提示风险，回答先给结论再列行动项。",
        "项目进度、会议和待办，一处看全。",
        ("这周还有哪些事没完成", "开始记会议纪要", "明天上午10点项目评审")),
    _profession(
        "sales", "销售 / 经纪人", "🤝", "记住每位客户的情况，跟进不掉链子",
        ("schedule", "todo", "memory", "recall", "feishu", "service_reply", "loan_calc"),
        (_flow("visit_notes", "拜访纪要", "随口说说拜访情况，整理出跟进事项并生成网页",
               ("input_text", {"label": "把今天拜访客户的情况随便说说"}), ("ai_extract", {"task": "待办"}),
               ("to_todo", {}), ("web_page", {"title": "拜访跟进"})),),
        "你是销售的工作助手：记客户情况和跟进节点、安排拜访、整理跟进事项，回答务实、拿来就能用。",
        "今天要跟进哪几位客户？",
        ("今天要拜访谁", "记住：李总爱喝普洱", "上次和张经理聊到哪了")),
    _profession(
        "teacher", "老师", "📚", "备课、课表、家校沟通，琐事交给它",
        ("schedule", "todo", "memo", "search", "essay_review", "official_doc", "study_plan"),
        (_flow("courseware", "课件提炼", "上传课件，按章节提炼要点，生成给学生看的网页",
               ("input_file", {}), ("split_file", {"mode": "chapter", "max_parts": 8}),
               ("ai_extract", {"task": "要点"}), ("web_page", {"title": "课件要点"})),),
        "你是老师的工作助手：排课表、备课提炼要点、记家校事务，表达清楚有条理。",
        "今天的课和作业，交给我来记。",
        ("明天有几节课", "记一下：周四开家长会", "帮我查查这个知识点怎么讲")),
    _profession(
        "student", "学生", "🎒", "作业、复习、查资料，学习不掉队",
        ("todo", "schedule", "search", "recall", "study_plan", "resume_helper", "interview_coach"),
        (_flow("quick_read", "资料速读", "上传一份资料，几秒钟读出摘要并生成网页",
               ("input_file", {}), ("ai_extract", {"task": "摘要"}), ("web_page", {"title": "资料速读"})),),
        "你是学生的学习助手：拆作业、排复习计划、查资料讲概念，讲解简洁、举例通俗。",
        "今天想先搞定哪门课？",
        ("这周有哪些作业要交", "提醒我周日复习高数", "帮我查下这个概念")),
    _profession(
        "creator", "内容创作者", "🎥", "追热点、攒素材、排选题，灵感不再溜走",
        ("search", "memo", "movies", "todo", "video_script", "social_post"),
        (_flow("topic_material", "选题素材", "贴一段素材或方向，提炼可写的角度并生成网页",
               ("input_text", {"label": "贴一段素材，或写下想做的选题方向"}), ("ai_extract", {"task": "要点"}),
               ("web_page", {"title": "选题素材"})),),
        "你是内容创作者的工作助手：找热点和素材、拆选题角度、记灵感和排期，给出拿来就能用的点子。",
        "今天想做点什么内容？素材我来找。",
        ("最近有啥热点值得做", "记个选题：打工人带饭", "这部新片口碑怎么样")),
    _profession(
        "office", "行政 / HR", "🗂️", "通知、会议、流程，琐碎事务有条不紊",
        ("schedule", "todo", "meeting", "feishu", "official_doc", "meeting_notes", "workday_calc"),
        (_flow("notice", "通知下发", "说说要通知的事，改写成正式通知并生成网页",
               ("input_text", {"label": "说说要通知什么事、时间地点、谁参加"}),
               ("ai_extract", {"task": "改写", "instruction": "改写成正式、简洁的内部通知，写清时间地点和注意事项"}),
               ("web_page", {"title": "通知"})),),
        "你是行政人事的工作助手：起草通知、安排会议、记流程和待办，措辞正式简洁。",
        "今天要发什么通知、排什么会？",
        ("帮我写一条国庆放假通知", "下周有哪些会", "开始记会议纪要")),
)

_PROFESSIONS_BY_ID = {item["id"]: item for item in PROFESSIONS}


def plugin_ids() -> list[str]:
    return [item["id"] for item in registry().entries]


def get_plugin(plugin_id: str) -> dict | None:
    item = registry().entry_by_id.get(plugin_id) if isinstance(plugin_id, str) else None
    return copy.deepcopy(item) if item else None


def get_profession(profession_id: str) -> dict | None:
    item = _PROFESSIONS_BY_ID.get(profession_id)
    return copy.deepcopy(item) if item else None


def is_plugin(plugin_id) -> bool:
    """市场里有这个插件（启用中；可能因依赖缺失暂不可用）。"""
    return isinstance(plugin_id, str) and plugin_id in registry().entry_by_id


def is_profession(profession_id) -> bool:
    return isinstance(profession_id, str) and profession_id in _PROFESSIONS_BY_ID


def tools_for(plugin_ids) -> set[str]:
    """一组插件对应的对话工具名（未知 id、停用或暂不可用的插件忽略）。"""
    current = registry()
    names: set[str] = set()
    for plugin_id in plugin_ids or ():
        if isinstance(plugin_id, str):
            names.update(current.tool_names(plugin_id))
    return names


def tool_display(tool_name: str) -> dict | None:
    """工具名 → 它所属插件的 {icon, name}（给对话里的工具芯片、飞书进度提示用）；找不到返回 None。"""
    if not isinstance(tool_name, str) or not tool_name:
        return None
    for entry in registry().entry_by_id.values():
        if tool_name in (entry.get("tools") or ()):
            return {"icon": entry.get("icon") or "🧩", "name": entry.get("name") or tool_name}
    return None


def pack_tools() -> list:
    """插件包自带的工具（已包好隔离层）：build_agent 把它们并进核心工具注册表。"""
    return list(registry().pack_tools)


def names_for(plugin_ids) -> list[str]:
    by_id = registry().entry_by_id
    return [by_id[pid]["name"] for pid in plugin_ids or () if pid in by_id]


def _files_ready() -> bool:
    try:
        return importlib.util.find_spec("jarvis.files") is not None
    except (ImportError, ValueError):
        return False


def requirement_status(user_id: str | None) -> dict[str, bool]:
    """前置条件对该账号是否满足；游客（None）一律视为满足。任何一项查询失败按不满足。"""
    if not user_id:
        return dict.fromkeys(REQUIREMENTS, True)
    status = dict.fromkeys(REQUIREMENTS, False)
    try:
        from jarvis.channels import feishu
        status["feishu_bound"] = bool(feishu.push_ready(user_id))
    except Exception as exc:
        log.info("feishu binding check failed: %s", type(exc).__name__)
    try:
        from jarvis.accounts import AccountStore
        owner = AccountStore().unique_active_owner()
        status["wechat_owner"] = bool(owner and owner.user_id == user_id)
    except Exception as exc:
        log.info("wechat owner check failed: %s", type(exc).__name__)
    try:
        from jarvis import meeting
        status["desktop"] = meeting.desktop_commands.online(user_id)
    except Exception as exc:
        log.info("desktop online check failed: %s", type(exc).__name__)
    status["files"] = _files_ready()
    return status


def availability(user_id: str | None) -> dict[str, bool]:
    """每个插件对该账号是否可用：插件本身加载正常，且 requires 全部满足。"""
    status = requirement_status(user_id)
    return {item["id"]: item["status"] == "ok" and all(status.get(need, False) for need in item["requires"])
            for item in registry().entries}


def is_available(plugin_id: str, user_id: str | None) -> bool:
    return is_plugin(plugin_id) and availability(user_id).get(plugin_id, False)


def catalog(user_id: str | None = None) -> dict:
    """市场目录：游客按「插件本身可用」计算，登录后再叠加账号的前置条件。"""
    current = registry()
    usable = availability(user_id)
    plugins = []
    for item in current.entries:
        entry = copy.deepcopy(item)
        entry["available"] = usable.get(item["id"], False)
        plugins.append(entry)
    return {"categories": [dict(item) for item in CATEGORIES], "plugins": plugins,
            "professions": copy.deepcopy(list(PROFESSIONS)), "accents": [dict(item) for item in ACCENTS]}


__all__ = [
    "ACCENTS", "ACCENT_VALUES", "BASE_TOOLS", "CATEGORIES", "EXTRACT_TASKS", "OWNER_TOOLS", "PLUGINS",
    "OWNER_ONLY", "PRO_PRICE", "PROFESSIONS", "REQUIREMENTS", "SPLIT_MODES", "availability", "catalog", "generation",
    "get_plugin", "get_profession", "is_available", "is_plugin", "is_profession", "names_for", "pack_tools",
    "plugin_ids", "registry", "reload", "requirement_status", "tools_for",
]
