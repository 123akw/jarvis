"""核心工具「这次没办成」的统一标记（第十九轮）。

工具不能抛异常（异常会穿透 agent.invoke，让整轮回复失败），所以失败一直是「回一句人话」。
问题是：对话里模型能读懂这句话并如实转告，流程执行器却分不清它和正常结果，会把
「天气服务暂时连不上…」当成天气数据传给下一步。

:class:`ToolFailure` 是 ``str`` 的子类：对话里照样是那句话（模型照常读到），流程执行器用
:func:`is_failure` 认出来，把这一步判为失败、整条停下，并给用户看 ``public``（去掉了只对模型说的话）。
"""
from __future__ import annotations

import re

# 只对模型说的话（「请如实告诉领导…」）与技术细节（括号里的异常名、配置项名）不给流程用户看
_FOR_MODEL = re.compile(r"[，,。；;]?\s*(?:请如实告诉领导|请告诉领导|请让领导|不要用相同参数重试)[^。]*。?")
_EXC_NAME = re.compile(r"（[A-Za-z][A-Za-z0-9_.]*(?:Error|Exception|Timeout)[A-Za-z]*）")


class ToolFailure(str):
    """核心工具的失败说明：仍是普通字符串，``public`` 是给流程用户看的人话。"""

    public: str = ""


def fail(text: str, public: str | None = None) -> ToolFailure:
    """把一句失败说明标成 :class:`ToolFailure`；``public`` 不给时自动去掉只对模型说的话与异常名。"""
    out = ToolFailure(text)
    out.public = public if public is not None else _clean(text)
    return out


def _clean(text: str) -> str:
    cleaned = _EXC_NAME.sub("", _FOR_MODEL.sub("。", str(text))).strip()
    cleaned = re.sub(r"。{2,}", "。", cleaned).strip("，, ")
    return cleaned or "这次没办成，请稍后再试"


def is_failure(value) -> bool:
    return isinstance(value, ToolFailure)


def public_text(value) -> str:
    """失败说明里给用户看的那句（非失败时原样返回文字）。"""
    return (value.public or _clean(value)) if isinstance(value, ToolFailure) else str(value)


SEARCH_NOT_CONFIGURED = "联网搜索还没配置好，请管理员在设置里配置搜索服务后再试"
