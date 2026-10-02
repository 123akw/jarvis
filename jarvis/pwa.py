"""平台 App 化（PWA）：manifest、主屏图标、最小 service worker。

- 图标纯 Python 生成（zlib + struct 写 PNG，生产没装 Pillow）：主题色底 + 柔和的光球
  径向渐变，与网页里的 AI 光球同一气质。整幅铺满不留透明边，可直接当 maskable 图标；
  光球半径约 0.3，落在 maskable 的安全区（中心 80%）内。
- service worker 只为满足「可安装」条件：网络优先、不用 Cache API、绝不碰 /api；
  离线时导航请求回一句人话。
"""
from __future__ import annotations

from functools import lru_cache
import math
import struct
import zlib

ICON_SIZES = (192, 512)
BACKGROUND = "#0B0B0F"   # 启动画面底色，与网页 --jv-bg 一致


def _rgb(accent: str) -> tuple[float, float, float]:
    value = accent.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def _mix(a, b, t: float):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def encode_png(width: int, height: int, rows: list[bytes]) -> bytes:
    """RGB 8 位 PNG；rows 是每行 width*3 字节（不含滤波字节）。"""
    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header)
            + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b""))


@lru_cache(maxsize=32)
def icon_png(accent: str, size: int) -> bytes:
    """主题色光球图标。按（主题色, 尺寸）缓存：512 图现算约 0.1 秒，之后直接复用。"""
    base = _rgb(accent)
    white, black = (1.0, 1.0, 1.0), (0.0, 0.0, 0.0)
    top, bottom = _mix(base, white, 0.06), _mix(base, black, 0.42)
    halo = _mix(base, white, 0.45)
    edge, core = _mix(base, white, 0.30), _mix(base, white, 0.92)
    cx, cy, radius = 0.5, 0.48, 0.29
    hx, hy = cx - 0.08, cy - 0.10            # 高光偏左上，像被光照着的球
    step = 1.0 / size
    rows: list[bytes] = []
    for y in range(size):
        fy = (y + 0.5) * step
        bg = _mix(top, bottom, fy ** 1.2)
        row = bytearray(size * 3)
        dy2 = (fy - cy) ** 2
        hy2 = (fy - hy) ** 2
        for x in range(size):
            fx = (x + 0.5) * step
            d = math.sqrt((fx - cx) ** 2 + dy2) / radius
            color = _mix(bg, halo, 0.55 * math.exp(-1.25 * d * d))          # 光晕：越近越亮
            if d < 1.08:
                h = math.sqrt((fx - hx) ** 2 + hy2) / radius
                body = _mix(core, edge, min(1.0, h ** 1.1))
                body = _mix(body, white, 0.6 * math.exp(-7.0 * h * h))       # 高光
                body = _mix(body, white, 0.22 * math.exp(-((d - 0.95) / 0.05) ** 2))  # 轮廓微光
                color = _mix(color, body, 0.92 * (1.0 - _smoothstep(0.94, 1.06, d)))
            i = x * 3
            row[i] = int(color[0] * 255 + 0.5)
            row[i + 1] = int(color[1] * 255 + 0.5)
            row[i + 2] = int(color[2] * 255 + 0.5)
        rows.append(bytes(row))
    return encode_png(size, size, rows)


def manifest(platform: dict) -> dict:
    slug = platform["slug"]
    name = platform["name"]
    data = {
        "id": f"/p/{slug}",
        "name": name,
        "short_name": name[:12],
        "start_url": f"/p/{slug}",
        "scope": "/",              # 登录后进主页（/）仍留在 App 里，不跳出到浏览器
        "display": "standalone",
        "orientation": "portrait",
        "lang": "zh-CN",
        "theme_color": platform["accent"],
        "background_color": BACKGROUND,
        "icons": [{"src": f"/p/{slug}/icon-{size}.png", "sizes": f"{size}x{size}", "type": "image/png",
                   "purpose": "any maskable"} for size in ICON_SIZES],
    }
    if platform.get("tagline"):
        data["description"] = platform["tagline"]
    return data


SERVICE_WORKER = """// 平台 App 的最小 service worker：只为满足「添加到主屏幕」的可安装条件。
// 网络优先、不缓存任何内容；/api 与跨域请求一律不经手。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || request.mode !== 'navigate') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0B0B0F;color:#f5f5f7;'
    + 'font:16px -apple-system,system-ui,sans-serif">网络好像断了，连上后再打开试试</body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
})
"""
