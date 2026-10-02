"""公开结果页 /r/<token>：服务端渲染、移动优先、零脚本。

安全口径：正文是模型 / 用户资料产出的，一律当不可信文本——先整体 html.escape，再只认
Markdown 的标题、列表、引用、段落和 **粗体** 这几种结构，自己拼标签；不支持内联 HTML、
图片和正文里的链接（链接只从 links 里来，且只认 https）。响应头再加一道 CSP（禁脚本）。
"""
from __future__ import annotations

import datetime as dt
import html
import re

DEFAULT_ACCENT = "#0A84FF"
DEFAULT_NAME = "贾维斯"
_ACCENT = re.compile(r"^#[0-9A-Fa-f]{6}$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(\S.*)$")
_BULLET = re.compile(r"^\s*[-*+•]\s+(.*)$")
_ORDERED = re.compile(r"^\s*\d{1,3}[.、)]\s*(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_CODE = re.compile(r"`([^`]+)`")

CSP = ("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; "
       "form-action 'none'; frame-ancestors 'none'")
HEADERS = {"Content-Security-Policy": CSP, "X-Robots-Tag": "noindex, nofollow",
           "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
           "Cache-Control": "no-store"}


def _inline(text: str) -> str:
    escaped = html.escape(text, quote=True)
    escaped = _BOLD.sub(r"<strong>\1</strong>", escaped)
    return _CODE.sub(r"<code>\1</code>", escaped)


def render_markdown(markdown: str) -> str:
    """Markdown 子集 → 安全 HTML。所有文字先转义，只输出本函数自己拼的标签。"""
    out: list[str] = []
    paragraph: list[str] = []
    list_tag = ""

    def flush_paragraph():
        if paragraph:
            out.append("<p>" + "<br>".join(_inline(x) for x in paragraph) + "</p>")
            paragraph.clear()

    def close_list():
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = ""

    def open_list(tag: str):
        nonlocal list_tag
        if list_tag != tag:
            close_list()
            out.append(f"<{tag}>")
            list_tag = tag

    for line in str(markdown or "").replace("\r\n", "\n").splitlines():
        if not line.strip():
            flush_paragraph(); close_list()
            continue
        if heading := _HEADING.match(line):
            flush_paragraph(); close_list()
            level = min(max(len(heading.group(1)), 2), 4)   # 页面标题占 h1，正文的 # / ## 都算 h2
            out.append(f"<h{level}>{_inline(heading.group(2).strip())}</h{level}>")
        elif bullet := _BULLET.match(line):
            flush_paragraph(); open_list("ul")
            out.append(f"<li>{_inline(bullet.group(1).strip())}</li>")
        elif ordered := _ORDERED.match(line):
            flush_paragraph(); open_list("ol")
            out.append(f"<li>{_inline(ordered.group(1).strip())}</li>")
        elif quote := _QUOTE.match(line):
            flush_paragraph(); close_list()
            out.append(f"<blockquote>{_inline(quote.group(1).strip())}</blockquote>")
        else:
            close_list()
            paragraph.append(line.strip())
    flush_paragraph(); close_list()
    return "\n".join(out)


def brand(platform: dict | None) -> dict:
    """平台名 / 图标 / 主题色；没有平台或字段不合法时退回贾维斯的默认值。"""
    platform = platform if isinstance(platform, dict) else {}
    name = " ".join(str(platform.get("name") or "").split())[:20]
    accent = str(platform.get("accent") or "")
    icon = str(platform.get("icon") or "")[:4]
    return {"name": name or DEFAULT_NAME, "icon": icon if name else "",
            "accent": accent if _ACCENT.match(accent) else DEFAULT_ACCENT, "custom": bool(name)}


def _when(iso: str) -> str:
    try:
        moment = dt.datetime.fromisoformat(iso).astimezone()
    except (TypeError, ValueError):
        return ""
    return moment.strftime("%Y-%m-%d %H:%M")


def _hex_rgb(accent: str) -> str:
    return ",".join(str(int(accent[i:i + 2], 16)) for i in (1, 3, 5))


_STYLE = """
:root{--accent:%(accent)s;--accent-rgb:%(rgb)s;--bg:#F5F5F7;--card:#FFFFFF;--text:#1D1D1F;--text-2:rgba(60,60,67,.76);
--line:rgba(60,60,67,.14);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0F;--card:rgba(30,30,36,.9);--text:#F5F5F7;--text-2:rgba(235,235,245,.66);
--line:rgba(235,235,245,.12)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%%}
body{margin:0;background:radial-gradient(900px 420px at 50%% -12%%,rgba(var(--accent-rgb),.16),transparent 64%%),var(--bg);
color:var(--text);font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
min-height:100vh;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:28px 16px 40px}
.brand{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);letter-spacing:.02em}
.dot{width:8px;height:8px;border-radius:50%%;background:var(--accent);box-shadow:0 0 12px rgba(var(--accent-rgb),.8)}
h1{font-size:26px;line-height:1.3;margin:14px 0 6px;letter-spacing:-.01em;word-break:break-word}
.meta{font-size:13px;color:var(--text-2);margin-bottom:22px}
article{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:6px 18px 14px;
box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.05);word-break:break-word}
article h2{font-size:19px;margin:22px 0 8px;padding-left:10px;border-left:3px solid var(--accent)}
article h3,article h4{font-size:16px;margin:18px 0 6px}
article p{margin:12px 0}
article ul,article ol{margin:10px 0;padding-left:22px}
article li{margin:6px 0}
article li::marker{color:var(--accent)}
blockquote{margin:12px 0;padding:8px 12px;border-radius:10px;background:rgba(var(--accent-rgb),.08);color:var(--text-2)}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(127,127,127,.14);padding:1px 5px;border-radius:5px}
.links{margin-top:18px;display:flex;flex-direction:column;gap:8px}
.links a{display:block;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);
color:var(--accent);text-decoration:none;font-size:15px}
footer{margin-top:28px;text-align:center;font-size:12px;color:var(--text-2)}
"""


def _page(*, title: str, brand_info: dict, body: str) -> str:
    style = _STYLE % {"accent": brand_info["accent"], "rgb": _hex_rgb(brand_info["accent"])}
    footer = (f"由『{html.escape(brand_info['name'])}』生成 · 贾维斯驱动" if brand_info["custom"]
              else "由贾维斯生成")
    mark = html.escape(brand_info["icon"]) or '<span class="dot"></span>'
    return (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
        "<meta name=\"robots\" content=\"noindex,nofollow\">"
        "<meta name=\"referrer\" content=\"no-referrer\">"
        f"<meta name=\"theme-color\" content=\"{brand_info['accent']}\">"
        f"<title>{html.escape(title)} · {html.escape(brand_info['name'])}</title>"
        f"<style>{style}</style></head><body><main>"
        f"<div class=\"brand\">{mark}<span>{html.escape(brand_info['name'])}</span></div>"
        f"{body}<footer>{footer}</footer></main></body></html>"
    )


def render_page(page: dict, platform: dict | None) -> str:
    info = brand(platform)
    links = [x for x in page.get("links") or []
             if isinstance(x, dict) and str(x.get("url", "")).startswith("https://")]
    link_html = ""
    if links:
        link_html = '<nav class="links">' + "".join(
            f'<a href="{html.escape(str(x["url"]), quote=True)}" rel="noopener noreferrer nofollow" target="_blank">'
            f'{html.escape(str(x.get("label") or "链接"))} →</a>' for x in links) + "</nav>"
    when = _when(page.get("created_at") or "")
    body = (f"<h1>{html.escape(page.get('title') or '结果')}</h1>"
            f"<div class=\"meta\">{'生成于 ' + when if when else ''}</div>"
            f"<article>{render_markdown(page.get('text') or '')}</article>{link_html}")
    return _page(title=page.get("title") or "结果", brand_info=info, body=body)


def render_missing() -> str:
    body = ("<h1>这个结果页不存在或已过期</h1>"
            "<div class=\"meta\">结果页保留 30 天；需要的话请让分享的人重新生成一次。</div>")
    return _page(title="结果页已过期", brand_info=brand(None), body=body)
