#!/usr/bin/env python3
"""积木流程本机冒烟（不进 CI）：临时数据目录里建「项目资料归档」流程，从 HTTP 层跑通
资料上传 → 文件拆分 → AI 提炼（要点）→ 生成网页，打印每步耗时与结果页地址。

用法：
    .venv/bin/python scripts/flow_smoke.py                    # 有模型密钥就真跑一次 AI 提炼
    .venv/bin/python scripts/flow_smoke.py --offline          # 不联网：AI 提炼用本地替身
    .venv/bin/python scripts/flow_smoke.py --env-file /path/.env --save output/round13-F

- 资料是脚本自己编的项目文档，现场拼成 .docx（走 Word 解析那条路）；
- 模型只调 1 次；密钥只从 .env / 环境变量读，绝不打印；
- 全程用临时目录，跑完即删，不碰真实 data/；不连飞书 / 微信。
全部步骤成功、结果页可打开且不含原样 HTML 时退出码 0。
"""
import argparse
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PROJECT_DOC = [
    "星河订单中台升级项目说明",
    "一、项目背景",
    "现有订单系统建于 2019 年，单体架构，去年双十一高峰期下单接口 P99 达到 2.4 秒，出现两次超卖。",
    "客服每月因订单状态不同步收到约 600 张工单，财务对账需要人工导出三张报表再合并。",
    "二、项目目标",
    "1）下单接口 P99 降到 300 毫秒以内，大促峰值支撑每秒 5000 单；",
    "2）库存扣减改为预占 + 确认两阶段，杜绝超卖；",
    "3）订单状态变更 5 秒内同步到客服系统和财务系统。",
    "三、范围与分工",
    "后端组（负责人：王磊）负责订单服务拆分与库存预占；数据组（负责人：陈思）负责对账数据同步；",
    "测试组（负责人：刘洋）负责压测方案，目标是在 10 月 25 日前完成全链路压测。",
    "四、里程碑",
    "10 月 10 日：完成接口设计评审；10 月 20 日：订单服务灰度 10%；",
    "10 月 28 日：全量切换；11 月 1 日：大促前封版。",
    "五、风险与应对",
    "风险一：老系统与新服务双写期间数据不一致——每晚跑一次对账脚本，差异超过 0.1% 立即回滚。",
    "风险二：压测环境资源不足——已向运维申请 20 台临时机器，10 月 15 日到位。",
    "风险三：客服系统接口限流——与客服系统约定批量推送，每 5 秒一批。",
    "六、预算",
    "总预算 86 万元：云资源 42 万，外包压测 18 万，人力加班补贴 26 万。",
]

FAKE_POINTS = ("## 项目背景\n- 老订单系统高峰期 P99 2.4 秒，出现过超卖\n- 每月约 600 张订单同步类工单\n"
               "## 目标\n- 下单 P99 < 300ms，峰值 5000 单/秒\n- 库存两阶段扣减，杜绝超卖\n"
               "## 里程碑\n- 10/10 设计评审 · 10/20 灰度 10% · 10/28 全量 · 11/1 封版\n"
               "## 风险\n- 双写不一致：每晚对账，差异 >0.1% 回滚\n## 预算\n- 共 86 万元")


def build_docx(paragraphs: list[str]) -> bytes:
    """拼一个最小可解析的 .docx（只放 document.xml，足够走 documents.extract_text）。"""
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        bundle.writestr("word/document.xml", xml)
    return buffer.getvalue()


def has_model_key() -> bool:
    return any(os.getenv(name, "").strip() for name in ("JARVIS_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--offline", action="store_true", help="不调真模型，AI 提炼用本地替身")
    parser.add_argument("--env-file", default=str(ROOT / ".env"), help="读模型密钥的 .env（默认项目根）")
    parser.add_argument("--save", default="", help="把结果页 HTML 存到这个目录（看效果 / 截图用）")
    args = parser.parse_args()

    from dotenv import load_dotenv
    if Path(args.env_file).is_file():
        load_dotenv(args.env_file)   # 已有的环境变量优先
    data_dir = tempfile.mkdtemp(prefix="jarvis-flow-smoke-")
    os.environ.update(JARVIS_DATA_DIR=data_dir, JARVIS_ADMIN_USERNAME="smoke", JARVIS_ADMIN_PASSWORD="smoke-pass-2026",
                      JARVIS_SESSION_SECRET="flow-smoke-session-secret-at-least-256-bits-long!!",
                      JARVIS_ENV="development", JARVIS_ALLOW_INSECURE_COOKIE="1")   # TestClient 走 http
    for name in ("FEISHU_APP_ID", "FEISHU_APP_SECRET"):
        os.environ.pop(name, None)   # 冒烟不连飞书
    try:
        return run(args)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)


def run(args) -> int:
    from fastapi.testclient import TestClient
    import jarvis.server as server_mod
    from jarvis import flows

    live = has_model_key() and not args.offline
    runtime = flows.runtime()
    if live:
        server_mod._initialize_runtime()   # 与正式启动一致：按账号解析模型（这里落到 .env 的默认模型）
        print("模型：用 .env 里的默认模型真跑一次 AI 提炼（密钥不打印）")
    else:
        runtime.deps.compose = lambda user_id, prompt: FAKE_POINTS
        print("模型：" + ("--offline，" if args.offline else "没找到模型密钥，") + "AI 提炼用本地替身")

    client = TestClient(server_mod.app)
    login = client.post("/api/login", json={"username": "smoke", "password": "smoke-pass-2026"})
    if login.status_code != 200:
        print("登录失败：", login.status_code); return 1
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]

    created = client.post("/api/flows", json={"name": "项目资料归档", "steps": [
        {"plugin": "input_file"},
        {"plugin": "split_file", "options": {"mode": "chapter", "max_parts": 8}},
        {"plugin": "ai_extract", "options": {"task": "要点"}},
        {"plugin": "web_page", "options": {"title": "星河订单中台 · 项目要点"}},
    ]})
    if created.status_code != 201:
        print("建流程失败：", created.json()); return 1
    flow = created.json()["flow"]
    print(f"流程：{flow['name']}（{flow['summary']}）")

    docx = build_docx(PROJECT_DOC)
    names = {s["id"]: flows.STEPS[s["plugin"]].name for s in flow["steps"]}
    began, output, ok = time.monotonic(), None, True
    with client.stream("POST", f"/api/flows/{flow['id']}/run", json={
            "file": {"name": "星河订单中台升级项目说明.docx", "data_base64": base64.b64encode(docx).decode()}}) as response:
        if response.status_code != 200:
            print("运行失败：", response.status_code, response.read().decode()); return 1
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            kind = event["type"]
            if kind in ("step_done", "step_error"):
                # 用服务端记的每步耗时：TestClient 会把整段流攒完才交出来，客户端计时不准
                text = event.get("summary") or event.get("message")
                mark = "✓" if kind == "step_done" else "✗"
                print(f"  {mark} {names[event['step_id']]}  {event.get('ms', 0):>6} ms  {text}")
                if kind == "step_done" and event.get("preview"):
                    print(f"      {event['preview'][:120]}")
                ok = ok and kind == "step_done"
            elif kind == "run_done":
                output = event["output"]
                print(f"整条：{event['status']}，{(time.monotonic() - began):.1f} 秒")
    if not ok or not output:
        return 1
    page = client.get(output["url"])
    data = client.get("/api" + output["url"]).json()
    print(f"结果页：{output['url']}（正式环境即 https://<你的域名>{output['url']}，扫码可看）")
    print(f"结果页 HTTP {page.status_code}，{len(page.text)} 字节，正文 {len(data['text'])} 字")
    if args.save:
        target = Path(args.save).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        (target / "flow_result.html").write_text(page.text, encoding="utf-8")
        (target / "flow_result.md").write_text(data["text"], encoding="utf-8")
        print(f"已保存：{target / 'flow_result.html'}")
    return 0 if page.status_code == 200 and "<script" not in page.text else 1


if __name__ == "__main__":
    sys.exit(main())
