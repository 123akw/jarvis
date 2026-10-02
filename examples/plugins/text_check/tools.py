"""文字体检：字数、段落、阅读时长、高频重复词、广告极限词与自定义敏感词提示。纯标准库，不联网。

重复词用「汉字 2–4 字片段 + 停用词过滤」近似，不做分词；广告词是常见口径的提示清单，
只作提醒，不构成法律意见。
"""
from __future__ import annotations

import re
from collections import Counter

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_TEXT_CHARS = 20000
MAX_CUSTOM_WORDS = 50
READ_CN_PER_MIN = 300      # 默读：每分钟约 300 个汉字
READ_EN_PER_MIN = 200      # 英文每分钟约 200 词
SPEAK_CN_PER_MIN = 220     # 朗读 / 口播：每分钟约 220 字

_HAN = re.compile(r"[一-鿿]")
_HAN_RUN = re.compile(r"[一-鿿]+")
_EN_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
_DIGIT = re.compile(r"\d+(?:\.\d+)?")
_PUNCT = re.compile(r"[，。！？、；：“”‘’（）《》【】…—,.!?;:()\"'\[\]-]")
_SENTENCE_END = re.compile(r"[。！？!?…]+|\n+")

# 首尾是这些字的片段多半是虚词搭配，不算「重复词」
_EDGE_CHARS = set("的了是在和与也就都而及或被把着过吗呢吧啊呀嘛很太更最又还不没有这那个们我你他她它")
_STOP_WORDS = {"我们", "你们", "他们", "她们", "一个", "这个", "那个", "没有", "什么", "可以", "就是",
               "不是", "自己", "因为", "所以", "但是", "如果", "已经", "还是", "这样", "时候", "现在",
               "一下", "一些", "大家", "觉得", "知道", "非常", "然后", "这些", "那些", "其实", "真的"}
_EN_STOP = {"the", "and", "for", "you", "are", "with", "that", "this", "have", "was", "but", "not", "your"}

# 常见广告极限词 / 绝对化用语（《广告法》第九条等口径）→ 建议改法
AD_WORDS: dict[str, str] = {
    "全网最低": "改成「实惠」「划算」", "全网最": "删掉「全网最」", "史上最": "删掉「史上最」",
    "最好": "改成「很好」「口碑好」", "最佳": "改成「优选」", "最优": "改成「优质」", "最强": "改成「很强」",
    "最低价": "改成「实惠价」", "最便宜": "改成「很实惠」", "最先进": "改成「先进」", "最正宗": "改成「正宗」",
    "最高级": "改成「高品质」", "第一品牌": "删掉，或写清具体榜单与年份", "销量第一": "写清数据来源与时间",
    "排名第一": "写清数据来源与时间", "NO.1": "删掉", "No.1": "删掉", "TOP1": "删掉",
    "唯一": "改成「特色」", "首选": "改成「推荐」", "顶级": "改成「高品质」", "极致": "改成「用心」",
    "国家级": "删掉（除非有官方认证文件）", "世界级": "删掉", "绝对": "删掉", "100%": "删掉或改成「高」",
    "百分百": "删掉", "万能": "改成「多用途」", "永久": "改成「长久」", "独家": "改成「特色」",
    "王牌": "改成「招牌」", "冠军": "写清赛事 / 榜单来源", "遥遥领先": "改成「表现出色」",
    "史无前例": "删掉", "前无古人": "删掉", "无敌": "删掉", "零风险": "删掉", "无副作用": "删掉",
    "根治": "删掉（涉及疗效，普通商品不能说）", "治愈": "删掉（涉及疗效）", "药到病除": "删掉（涉及疗效）",
    "秒杀全网": "删掉", "免检": "删掉",
}
# 只在这些搭配里出现时不算极限词
_AD_EXCEPTIONS = {"绝对": ("绝对值", "绝对零度"), "唯一": ("唯一的办法",), "永久": ("永久居民",)}

# 明显的打字重复：虚词叠用（「天天」「常常」这类正常叠词不在其中）
_TYPO_REPEAT = re.compile(r"(的的|了了|是是|在在|和和|我我|你你|就就|都都|也也|吗吗)")
_PUNCT_REPEAT = re.compile(r"([，。、；：,.])\1+")


def _minutes(value: float) -> str:
    if value < 1:
        return "不到 1 分钟"
    return f"约 {round(value)} 分钟"


def stats(text: str) -> dict:
    han = len(_HAN.findall(text))
    en_words = len(_EN_WORD.findall(text))
    paragraphs = [p for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    sentences = [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]
    longest = max(sentences, key=len) if sentences else ""
    return {
        "chars": len(re.sub(r"\s", "", text)), "han": han, "en_words": en_words,
        "digits": len(_DIGIT.findall(text)), "punct": len(_PUNCT.findall(text)),
        "paragraphs": len(paragraphs), "sentences": len(sentences),
        "avg_sentence": round(sum(map(len, sentences)) / len(sentences)) if sentences else 0,
        "longest": longest,
        "read_min": han / READ_CN_PER_MIN + en_words / READ_EN_PER_MIN,
        "speak_min": han / SPEAK_CN_PER_MIN + en_words / (READ_EN_PER_MIN * 0.75),
    }


def repeated_words(text: str, min_count: int = 3, top: int = 5) -> list[tuple[str, int]]:
    counts: Counter = Counter()
    for run in _HAN_RUN.findall(text):
        for size in (2, 3, 4):
            for i in range(len(run) - size + 1):
                gram = run[i:i + size]
                if gram[0] in _EDGE_CHARS or gram[-1] in _EDGE_CHARS or gram in _STOP_WORDS:
                    continue
                counts[gram] += 1
    for word in _EN_WORD.findall(text):
        word = word.lower()
        if len(word) >= 3 and word not in _EN_STOP:
            counts[word] += 1
    frequent = {w: c for w, c in counts.items() if c >= min_count}
    # 「贾维斯」出现 5 次时「贾维」「维斯」也各 5 次：被同频更长片段包含的短片段去掉
    kept = {w: c for w, c in frequent.items()
            if not any(w != o and w in o and c == frequent[o] for o in frequent)}
    return sorted(kept.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0]))[:top]


def _context(text: str, start: int, end: int, pad: int = 8) -> str:
    left, right = max(0, start - pad), min(len(text), end + pad)
    snippet = text[left:right].replace("\n", " ")
    return ("…" if left else "") + snippet + ("…" if right < len(text) else "")


def _excepted(text: str, word: str, start: int) -> bool:
    """命中处其实是「绝对值」「绝对零度」这类正常搭配。"""
    for phrase in _AD_EXCEPTIONS.get(word, ()):
        offset = phrase.find(word)
        if 0 <= offset <= start and text.startswith(phrase, start - offset):
            return True
    return False


def find_words(text: str, words: dict[str, str]) -> list[dict]:
    """按词表找命中：同一位置只记最长的词（「全网最低」不再重复记「全网最」）。"""
    hits, taken = [], set()
    for word in sorted(words, key=len, reverse=True):
        for match in re.finditer(re.escape(word), text, flags=re.I):
            span = set(range(match.start(), match.end()))
            if span & taken:
                continue
            if _excepted(text, word, match.start()):
                continue
            taken |= span
            hits.append({"word": word, "advice": words[word], "pos": match.start(),
                         "context": _context(text, match.start(), match.end())})
    return sorted(hits, key=lambda h: h["pos"])


def custom_words(raw: str) -> dict[str, str]:
    words = [w.strip() for w in re.split(r"[,，、\s]+", raw or "") if w.strip()]
    return {w[:20]: "你指定要避开的词" for w in words[:MAX_CUSTOM_WORDS]}


def _word_report(text: str, sensitive_words: str) -> list[str]:
    lines = []
    hits = find_words(text, AD_WORDS)
    if hits:
        lines.append(f"⚠️ 广告极限词 {len(hits)} 处（发商品文案、朋友圈广告时容易被投诉或处罚）：")
        lines += [f"- 「{h['word']}」在「{h['context']}」→ {h['advice']}" for h in hits[:15]]
        if len(hits) > 15:
            lines.append(f"- ……另有 {len(hits) - 15} 处同类问题")
    custom = custom_words(sensitive_words)
    if custom:
        own = find_words(text, custom)
        if own:
            lines.append(f"⚠️ 你指定的敏感词 {len(own)} 处：")
            lines += [f"- 「{h['word']}」在「{h['context']}」" for h in own[:15]]
        else:
            lines.append("✅ 没有出现你指定的敏感词。")
    return lines


def _prepare(text: str) -> tuple[str, str]:
    text = (text or "").replace("\r\n", "\n").strip()
    note = ""
    if len(text) > MAX_TEXT_CHARS:
        text, note = text[:MAX_TEXT_CHARS], f"（文字太长，只检查了前 {MAX_TEXT_CHARS} 字）"
    return text, note


def check(text: str, sensitive_words: str = "") -> str:
    text, note = _prepare(text)
    if not text:
        return "没有收到要检查的文字，请把内容贴进来。"
    s = stats(text)
    lines = [f"📋 文字体检报告{note}",
             f"- 字数：{s['chars']}（汉字 {s['han']}、英文单词 {s['en_words']}、数字 {s['digits']} 处、标点 {s['punct']}）",
             f"- 结构：{s['paragraphs']} 段、{s['sentences']} 句，平均每句 {s['avg_sentence']} 字",
             f"- 阅读：默读{_minutes(s['read_min'])}，念出来{_minutes(s['speak_min'])}"]
    if len(s["longest"]) > 60:
        lines.append(f"- 最长的一句有 {len(s['longest'])} 字，读着费劲，建议拆开：「{s['longest'][:30]}…」")
    repeats = repeated_words(text)
    if repeats:
        lines.append("- 用得多的词：" + "、".join(f"「{w}」{c} 次" for w, c in repeats))
    typos = sorted(set(_TYPO_REPEAT.findall(text)))
    punct = sorted({m.group(0) for m in _PUNCT_REPEAT.finditer(text)})
    if typos or punct:
        lines.append("- 可能打错了：" + "、".join(f"「{x}」" for x in typos + punct))
    lines += _word_report(text, sensitive_words) or ["✅ 没发现常见的广告极限词。"]
    lines.append("（以上是机器提示，仅供参考）")
    return "\n".join(lines)


def check_ad_words(text: str, sensitive_words: str = "") -> str:
    text, note = _prepare(text)
    if not text:
        return "没有收到要检查的文字，请把内容贴进来。"
    report = _word_report(text, sensitive_words)
    if not report:
        return f"✅ 没发现常见的广告极限词{note}。（机器提示，仅供参考）"
    return "\n".join([*report, f"（机器提示，仅供参考；以当地市场监管口径为准）{note}"])


# ---------- 工具 ----------

class CheckArgs(BaseModel):
    text: str = Field(description="要检查的文字原文，原样传入，不要改写或删减")
    sensitive_words: str = Field(default="", description="可空；用户额外指定要避开的词，用逗号隔开")


@tool(args_schema=CheckArgs)
def text_check(text: str, sensitive_words: str = "") -> str:
    """给一段文字做体检：字数、段落、句子长度、阅读和朗读时长、高频重复词、疑似打错的叠字、
    广告极限词与用户指定的敏感词。用户说「帮我数数字数」「这篇文章要读多久」「帮我检查一下这段文案」时使用。"""
    return check(text, sensitive_words)


@tool(args_schema=CheckArgs)
def text_check_ad_words(text: str, sensitive_words: str = "") -> str:
    """只检查广告极限词（最好、第一、顶级、100% 等）和用户指定的敏感词，并给出改法。
    用户要发商品文案、朋友圈广告、海报前问「这样写有没有违规词」时使用。"""
    return check_ad_words(text, sensitive_words)


TOOLS = [text_check, text_check_ad_words]
