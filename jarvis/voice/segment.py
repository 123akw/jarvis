"""把流式 token 切成适合送 TTS 的句子：边生成边合成，保住首包延迟。"""
from __future__ import annotations

import re

_HARD_BOUNDARIES = "。！？!?；;…\n"
_SOFT_BOUNDARIES = "，,、：:"
_MIN_CHARS = 6    # 太短的句子不值一次 TTS 往返，攒一攒
_MAX_CHARS = 80   # 攒太长会拖慢首包，强制在软边界切

_MD_CODE_BLOCK = re.compile(r"```[\s\S]*?```")
_MD_INLINE = re.compile(r"[*_`#>]+")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_BARE_URL = re.compile(r"https?://[^\s）)\]】>，。；;、]+")
_MD_TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$", re.MULTILINE)


def speakable(text: str) -> str:
    """去掉念不出口的内容：Markdown 痕迹、代码块、裸 URL、表格行。
    字幕仍显示完整原文（gateway 的 token 事件不经过这里），这里只管「口语版」。"""
    text = _MD_CODE_BLOCK.sub("（代码略）", text)
    text = _MD_LINK.sub(r"\1", text)
    text = _BARE_URL.sub("（链接略）", text)
    text = _MD_TABLE_ROW.sub("", text)  # 表格不出声，结论由正文句子承担
    text = _MD_INLINE.sub("", text)
    return text.strip()


class SentenceSegmenter:
    """吃 token、吐整句。硬标点断句，超长时在软标点断，流结束用 flush 收尾。"""

    def __init__(self, min_chars: int = _MIN_CHARS, max_chars: int = _MAX_CHARS) -> None:
        self.min_chars = min_chars
        self.max_chars = max_chars
        self._buf = ""

    def push(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        while True:
            cut = self._find_cut()
            if cut is None:
                break
            sentence = self._buf[:cut].strip()
            self._buf = self._buf[cut:]
            if sentence:
                out.append(sentence)
        return out

    def flush(self) -> str | None:
        sentence = self._buf.strip()
        self._buf = ""
        return sentence or None

    def _find_cut(self) -> int | None:
        for i, ch in enumerate(self._buf):
            if ch in _HARD_BOUNDARIES and i + 1 >= self.min_chars:
                return i + 1
        if len(self._buf) > self.max_chars:
            window = self._buf[: self.max_chars]
            for i in range(len(window) - 1, -1, -1):
                if window[i] in _SOFT_BOUNDARIES and i + 1 >= self.min_chars:
                    return i + 1
            return self.max_chars
        return None


class FirstFastSegmenter(SentenceSegmenter):
    """首句用小阈值尽早在软标点开口（保「说完→首音频」延迟），之后恢复正常节奏。

    背景：口语化回答常常整段只有末尾一个句号（如「先给结论：……，……。」），
    普通切句会等完整硬标点才送 TTS，首音频被拖到全句生成完。首句提前在逗号/冒号
    处开口可省 1 秒级延迟，且软标点断句对合成韵律无伤。
    """

    def __init__(self, min_chars: int = _MIN_CHARS, max_chars: int = _MAX_CHARS,
                 first_max_chars: int = 24) -> None:
        super().__init__(min_chars=min_chars, max_chars=first_max_chars)
        self._steady_max = max_chars

    def push(self, text: str) -> list[str]:
        out = super().push(text)
        if out:
            self.max_chars = self._steady_max  # 已开口，恢复正常句长
        return out
