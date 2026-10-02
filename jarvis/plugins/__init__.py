"""智能平台市场的插件与职业清单（第十三轮，契约见 docs/proposals/2026-10-round13-platform.md 4.1）。

插件是现有能力的重新包装：对话工具按用户能理解的「技能」重组，加上微信 / 飞书通道和
流程积木。id 是对外契约（前端、流程引擎、平台存储都按 id 引用），只许加不许改；
名称、简介、示例可以打磨。

- ``catalog(user_id)``：市场目录（分类 / 插件 / 职业 / 主题色），``available`` 按账号计算；
- ``tools_for(ids)``：一组插件对应的对话工具名，平台账号的 Agent 只绑定这些（外加 now、calc）；
- ``requirement_status(user_id)``：``feishu_bound`` / ``wechat_owner`` / ``desktop`` 是否满足。
"""
from __future__ import annotations

import copy
import logging

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

# 任何平台都默认带上的基础能力（不进市场）；Owner 专属工具只给 Owner，也不进市场
BASE_TOOLS = ("now", "calc")
OWNER_TOOLS = ("coding_status", "sys_query")
REQUIREMENTS = ("feishu_bound", "wechat_owner", "desktop")

_ALL = ["shop_owner", "freelancer", "project_manager", "sales", "teacher", "student", "creator", "office"]
PRO_PRICE = 9.9          # 专业版插件价格，单位「元/月」（本轮只展示不收费）


def _plugin(id, name, icon, category, summary, kind="tool", *, tools=(), requires=(),
            tier="free", professions=(), examples=()) -> dict:
    return {"id": id, "name": name, "icon": icon, "category": category, "summary": summary,
            "kind": kind, "tools": list(tools), "step": None, "requires": list(requires),
            "tier": tier, "price": PRO_PRICE if tier == "pro" else 0, "professions": list(professions),
            "examples": list(examples), "available": True}


def _option(key, label, type_, default, choices=None) -> dict:
    option = {"key": key, "label": label, "type": type_, "default": default}
    if choices is not None:
        option["choices"] = list(choices)
    return option


# 积木的 step 定义以流程引擎为准（jarvis.flows.step_catalog，单一事实来源）；
# 流程模块不在时（单独测试或拆分部署）用下面这份同形状的兜底。
EXTRACT_TASKS = ("要点", "待办", "摘要", "周报", "改写")
SPLIT_MODES = ("chapter", "paragraph", "size")
_FALLBACK_STEPS = {
    "input_text": {"role": "input", "accepts": [], "produces": ["text"],
                   "options": [_option("label", "输入框提示", "text", "贴一段文字")]},
    "input_file": {"role": "input", "accepts": [], "produces": ["text"], "options": []},
    "split_file": {"role": "process", "accepts": ["text"], "produces": ["parts", "text"],
                   "options": [_option("mode", "拆分方式", "select", "chapter", SPLIT_MODES),
                               _option("max_parts", "最多几段", "number", 8)]},
    "ai_extract": {"role": "process", "accepts": ["text", "parts"], "produces": ["text", "items"],
                   "options": [_option("task", "做什么", "select", "要点", EXTRACT_TASKS),
                               _option("instruction", "补充要求", "text", "")]},
    "to_todo": {"role": "output", "accepts": ["items", "text"], "produces": [], "options": []},
    "feishu_send": {"role": "output", "accepts": ["text"], "produces": [], "options": []},
    "feishu_doc": {"role": "output", "accepts": ["text", "parts"], "produces": ["links"], "options": []},
    "wechat_send": {"role": "output", "accepts": ["text"], "produces": [], "options": []},
    "web_page": {"role": "output", "accepts": ["text", "parts", "links"], "produces": ["links"],
                 "options": [_option("title", "网页标题", "text", "")]},
}


def _step_specs() -> dict[str, dict]:
    try:
        from jarvis.flows import step_catalog
        specs = step_catalog()
    except ImportError:
        return copy.deepcopy(_FALLBACK_STEPS)
    return {key: copy.deepcopy(specs.get(key) or _FALLBACK_STEPS[key]) for key in _FALLBACK_STEPS}


PLUGINS: tuple[dict, ...] = (
    _plugin("schedule", "日程提醒", "📅", "efficiency", "说一句话就记下安排，到点提醒你",
            tools=("schedule_add", "schedule_list", "schedule_del"),
            professions=("shop_owner", "freelancer", "project_manager", "sales", "teacher", "student", "office"),
            examples=("明天下午3点和客户开会", "周五晚上提醒我交房租", "我下周都有啥安排")),
    _plugin("todo", "待办清单", "✅", "efficiency", "要办的事随口一说就记下，办完勾掉",
            tools=("todo_add", "todo_list", "todo_done"), professions=_ALL,
            examples=("记一下，给王姐回个电话", "今天还有啥没干完", "第二条搞定了")),
    _plugin("memo", "随手记", "📝", "efficiency", "灵感、地址、电话随手存，用时一问就有",
            tools=("memo_add", "memo_list", "memo_del"),
            professions=("shop_owner", "freelancer", "teacher", "creator"),
            examples=("记下来：送货的刘哥电话是 139 开头那个", "我之前记的那个店铺地址在哪")),
    _plugin("memory", "记住你的习惯", "🧠", "ai", "记住你和客户的偏好，越用越顺手",
            tools=("profile_remember", "profile_list", "profile_forget"),
            professions=("shop_owner", "sales"),
            examples=("记住我不吃香菜", "你都记得我些啥")),
    _plugin("weather", "查天气", "🌤️", "life", "出门前问一句，穿什么、带不带伞都告诉你",
            tools=("weather", "weather_here", "my_location"), professions=("shop_owner",),
            examples=("明天会下雨吗", "周末杭州天气咋样")),
    _plugin("search", "上网查资料", "🔎", "info", "查最新消息和网页，回答附上来源",
            tools=("web_search", "web_extract"),
            professions=("shop_owner", "freelancer", "project_manager", "teacher", "student", "creator"),
            examples=("最近奶茶店都在搞什么活动", "帮我查下个体户报税有什么新规定")),
    _plugin("recall", "找回聊过的话", "🗂️", "efficiency", "以前聊过的事，一句话就翻出来",
            tools=("recall_history",), professions=("freelancer", "project_manager", "sales", "student"),
            examples=("上次你推荐的那家火锅叫啥", "我上周跟你说的报价是多少来着")),
    _plugin("movies", "查影视评分", "🎬", "info", "一部片子几个平台的评分和人数，一次看全",
            tools=("movie_ratings",), professions=("creator",),
            examples=("《哪吒2》评分怎么样", "最近有啥高分电影")),
    _plugin("esports", "查电竞比分", "🎮", "info", "关注的战队最近打得怎么样，赛果一问便知",
            tools=("esports_scores",),
            examples=("T1 最近几场赢了没", "今晚 LPL 谁打谁")),
    _plugin("tickets", "查票价与入口", "🎫", "life", "演出、展览门票多平台比价，提醒手续费",
            tools=("ticket_search",),
            examples=("周杰伦深圳场的票哪里买划算", "上海迪士尼门票现在多少钱")),
    _plugin("meeting", "会议纪要", "🎙️", "efficiency", "开会时自动记下双方发言，会后出纪要发邮箱",
            tools=("meeting_start", "meeting_stop"), requires=("desktop",), tier="pro",
            professions=("project_manager", "office"),
            examples=("开始记会议纪要，主题是周例会", "会开完了，停止记录")),
    _plugin("feishu", "飞书", "🪶", "communication", "在飞书里直接找它办事、收提醒",
            kind="channel", professions=("freelancer", "project_manager", "sales", "office"),
            examples=("（在飞书里）明早9点提醒我交周报",)),
    _plugin("wechat", "微信技能包", "💬", "communication", "在微信里和它办事，提醒和晨报直接发到微信",
            kind="channel", requires=("wechat_owner",), tier="pro",
            examples=("（在微信里）帮我记一下明天去银行",)),
    _plugin("input_text", "文字输入", "✍️", "documents", "贴一段文字作为流程的起点", kind="step",
            examples=("把客户发来的需求贴进来",)),
    _plugin("input_file", "资料上传", "📎", "documents", "上传 PDF、Word、TXT、图片，自动读出文字", kind="step",
            examples=("把这份项目方案传上来",)),
    _plugin("split_file", "文件拆分", "✂️", "documents", "长资料按章节或段落拆成几份，逐份处理", kind="step",
            examples=("把这份 30 页的合同按章节拆开",)),
    _plugin("ai_extract", "AI 提炼", "✨", "ai", "提要点、列待办、写摘要和周报，一步搞定", kind="step",
            examples=("从会议记录里挑出谁要做什么",)),
    _plugin("to_todo", "加到待办", "📌", "output", "上一步整理出的事项，逐条写进待办清单", kind="step",
            examples=("提炼出的待办一键加进清单",)),
    _plugin("feishu_send", "发到飞书", "📨", "output", "把结果发给你绑定的飞书", kind="step",
            requires=("feishu_bound",), examples=("整理好的通知发到我飞书",)),
    _plugin("feishu_doc", "汇总到飞书文档", "📄", "output", "结果汇总成一篇飞书文档，没权限时改为发消息",
            kind="step", requires=("feishu_bound",), tier="pro", examples=("项目资料要点存成飞书文档",)),
    _plugin("wechat_send", "发到微信", "📲", "output", "把结果发到你的微信", kind="step",
            requires=("wechat_owner",), tier="pro", examples=("上新文案发到我微信",)),
    _plugin("web_page", "生成网页与二维码", "🔗", "output", "结果生成一个手机好看的网页，扫码就能打开",
            kind="step", examples=("纪要做成网页，发个二维码给同事",)),
)
_STEP_SPECS = _step_specs()
for _item in PLUGINS:
    if _item["kind"] == "step":
        _item["step"] = _STEP_SPECS[_item["id"]]

_BY_ID = {item["id"]: item for item in PLUGINS}
# 只有 Owner 能用的插件（微信桥只连 Owner）：推荐给其他人时一律剔除
OWNER_ONLY = frozenset(item["id"] for item in PLUGINS if "wechat_owner" in item["requires"])


def _flow(id, name, summary, *steps) -> dict:
    return {"id": id, "name": name, "summary": summary,
            "steps": [{"plugin": plugin, "options": dict(options)} for plugin, options in steps]}


def _profession(id, name, icon, summary, plugins, flows, persona, greeting, chips) -> dict:
    return {"id": id, "name": name, "icon": icon, "summary": summary, "plugins": list(plugins),
            "flows": list(flows), "persona": persona, "home": {"greeting": greeting, "chips": list(chips)}}


# 模板流程只用新账号一定能跑通的积木（不靠飞书绑定、不靠 Owner），一律以「生成网页」收尾
PROFESSIONS: tuple[dict, ...] = (
    _profession(
        "shop_owner", "个体店主 / 微商", "🏪", "进货、上新、排班和老客，小店的事都能交代",
        ("memo", "todo", "schedule", "weather", "search", "memory"),
        (_flow("new_arrival", "上新文案", "说说新品卖点，一键写成朋友圈文案并生成网页",
               ("input_text", {"label": "说说新品是什么、卖点有哪些"}),
               ("ai_extract", {"task": "改写", "instruction": "写成适合发朋友圈的上新文案，口语化，带两三个表情"}),
               ("web_page", {"title": "今日上新"})),),
        "你是小店的经营助手：管进货、排班、上新文案和老客记录，回答直接给能落地的做法。",
        "今天店里要办的事，说一声我来记。",
        ("明天天气适合搞活动吗", "记一下：周三补货牛奶", "帮我写条上新朋友圈")),
    _profession(
        "freelancer", "自由职业者", "🧑‍💻", "接单、交付、回款，一个人也安排得明明白白",
        ("schedule", "todo", "memo", "search", "recall", "feishu"),
        (_flow("client_brief", "客户需求整理", "客户发来的一大段需求，拆成待办并生成清单页",
               ("input_text", {"label": "把客户发来的需求贴进来"}), ("ai_extract", {"task": "待办"}),
               ("to_todo", {}), ("web_page", {"title": "客户需求清单"})),),
        "你是自由职业者的工作助手：拆客户需求、排交付时间、记报价和回款，回答干脆、先给结论。",
        "今天要交付的活儿，一件件排给你。",
        ("今天有哪些安排", "记一下：周五前交初稿", "上次那个客户的报价是多少")),
    _profession(
        "project_manager", "项目经理", "📊", "资料、会议、进度和风险，一处看全",
        ("schedule", "todo", "meeting", "feishu", "recall", "search"),
        (_flow("project_archive", "项目资料归档", "上传项目资料，拆分提炼要点，生成待办与网页",
               ("input_file", {}), ("split_file", {"mode": "chapter", "max_parts": 8}),
               ("ai_extract", {"task": "要点"}), ("to_todo", {}), ("web_page", {"title": "项目资料要点"})),),
        "你是项目经理的工作助手：拆任务、追进度、记会议、提示风险，回答先给结论再列行动项。",
        "项目进度、会议和待办，一处看全。",
        ("这周还有哪些事没完成", "开始记会议纪要", "明天上午10点项目评审")),
    _profession(
        "sales", "销售 / 经纪人", "🤝", "记住每位客户的情况，跟进不掉链子",
        ("schedule", "todo", "memory", "recall", "feishu"),
        (_flow("visit_notes", "拜访纪要", "随口说说拜访情况，整理出跟进事项并生成网页",
               ("input_text", {"label": "把今天拜访客户的情况随便说说"}), ("ai_extract", {"task": "待办"}),
               ("to_todo", {}), ("web_page", {"title": "拜访跟进"})),),
        "你是销售的工作助手：记客户情况和跟进节点、安排拜访、整理跟进事项，回答务实、拿来就能用。",
        "今天要跟进哪几位客户？",
        ("今天要拜访谁", "记住：李总爱喝普洱", "上次和张经理聊到哪了")),
    _profession(
        "teacher", "老师", "📚", "备课、课表、家校沟通，琐事交给它",
        ("schedule", "todo", "memo", "search"),
        (_flow("courseware", "课件提炼", "上传课件，按章节提炼要点，生成给学生看的网页",
               ("input_file", {}), ("split_file", {"mode": "chapter", "max_parts": 8}),
               ("ai_extract", {"task": "要点"}), ("web_page", {"title": "课件要点"})),),
        "你是老师的工作助手：排课表、备课提炼要点、记家校事务，表达清楚有条理。",
        "今天的课和作业，交给我来记。",
        ("明天有几节课", "记一下：周四开家长会", "帮我查查这个知识点怎么讲")),
    _profession(
        "student", "学生", "🎒", "作业、复习、查资料，学习不掉队",
        ("todo", "schedule", "search", "recall"),
        (_flow("quick_read", "资料速读", "上传一份资料，几秒钟读出摘要并生成网页",
               ("input_file", {}), ("ai_extract", {"task": "摘要"}), ("web_page", {"title": "资料速读"})),),
        "你是学生的学习助手：拆作业、排复习计划、查资料讲概念，讲解简洁、举例通俗。",
        "今天想先搞定哪门课？",
        ("这周有哪些作业要交", "提醒我周日复习高数", "帮我查下这个概念")),
    _profession(
        "creator", "内容创作者", "🎥", "追热点、攒素材、排选题，灵感不再溜走",
        ("search", "memo", "movies", "todo"),
        (_flow("topic_material", "选题素材", "贴一段素材或方向，提炼可写的角度并生成网页",
               ("input_text", {"label": "贴一段素材，或写下想做的选题方向"}), ("ai_extract", {"task": "要点"}),
               ("web_page", {"title": "选题素材"})),),
        "你是内容创作者的工作助手：找热点和素材、拆选题角度、记灵感和排期，给出拿来就能用的点子。",
        "今天想做点什么内容？素材我来找。",
        ("最近有啥热点值得做", "记个选题：打工人带饭", "这部新片口碑怎么样")),
    _profession(
        "office", "行政 / HR", "🗂️", "通知、会议、流程，琐碎事务有条不紊",
        ("schedule", "todo", "meeting", "feishu"),
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
    return [item["id"] for item in PLUGINS]


def get_plugin(plugin_id: str) -> dict | None:
    item = _BY_ID.get(plugin_id)
    return copy.deepcopy(item) if item else None


def get_profession(profession_id: str) -> dict | None:
    item = _PROFESSIONS_BY_ID.get(profession_id)
    return copy.deepcopy(item) if item else None


def is_plugin(plugin_id) -> bool:
    return isinstance(plugin_id, str) and plugin_id in _BY_ID


def is_profession(profession_id) -> bool:
    return isinstance(profession_id, str) and profession_id in _PROFESSIONS_BY_ID


def tools_for(plugin_ids) -> set[str]:
    """一组插件对应的对话工具名（未知 id 忽略）。"""
    names: set[str] = set()
    for plugin_id in plugin_ids or ():
        item = _BY_ID.get(plugin_id)
        if item:
            names.update(item["tools"])
    return names


def names_for(plugin_ids) -> list[str]:
    return [_BY_ID[pid]["name"] for pid in plugin_ids or () if pid in _BY_ID]


def requirement_status(user_id: str | None) -> dict[str, bool]:
    """三项前置条件对该账号是否满足；游客（None）一律视为满足。任何一项查询失败按不满足。"""
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
    return status


def availability(user_id: str | None) -> dict[str, bool]:
    """每个插件对该账号是否可用（requires 全部满足）。"""
    status = requirement_status(user_id)
    return {item["id"]: all(status.get(need, False) for need in item["requires"]) for item in PLUGINS}


def is_available(plugin_id: str, user_id: str | None) -> bool:
    return is_plugin(plugin_id) and availability(user_id)[plugin_id]


def catalog(user_id: str | None = None) -> dict:
    """市场目录：游客 available 恒为 true，登录后按账号计算。"""
    usable = availability(user_id)
    plugins = []
    for item in PLUGINS:
        entry = copy.deepcopy(item)
        entry["available"] = usable[item["id"]]
        plugins.append(entry)
    return {"categories": [dict(item) for item in CATEGORIES], "plugins": plugins,
            "professions": copy.deepcopy(list(PROFESSIONS)), "accents": [dict(item) for item in ACCENTS]}


__all__ = [
    "ACCENTS", "ACCENT_VALUES", "BASE_TOOLS", "CATEGORIES", "EXTRACT_TASKS", "OWNER_TOOLS", "PLUGINS",
    "OWNER_ONLY", "PRO_PRICE", "PROFESSIONS", "REQUIREMENTS", "SPLIT_MODES", "availability", "catalog", "get_plugin",
    "get_profession", "is_available", "is_plugin", "is_profession", "names_for", "plugin_ids",
    "requirement_status", "tools_for",
]
