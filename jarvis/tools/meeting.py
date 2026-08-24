"""会议纪要工具：把「开始/停止监控会议」的指令投递给桌面端执行。

音频采集只有 macOS 桌面端能做（麦克风=「我」+ 系统回环=「对方」），工具本身不碰
音频：它往 jarvis.meeting.desktop_commands 领取箱投一条指令，桌面端约 10 秒内轮询
领取并开始/结束采集；纪要生成与邮件发送由服务端在会议结束时自动完成。
"""
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis import meeting
from jarvis.tenancy import current_owner_id


class MeetingStartArgs(BaseModel):
    title: str = Field(default="", description="会议主题（可选，如「产品周会」），会写进纪要标题")


class MeetingStopArgs(BaseModel):
    pass


@tool(args_schema=MeetingStartArgs)
def meeting_start(title: str = "") -> str:
    """开始监控当前会议并生成会议纪要（飞书等会议的双方声音由桌面端采集）。领导说「监控会议」「帮我记会议纪要」「开始记录会议」时使用。"""
    owner = current_owner_id()
    if meeting.active_meetings.get(owner) is not None:
        return "已经有一场会议在监控中了，无需重复开始；结束时说「停止监控会议」即可。"
    meeting.desktop_commands.put(
        owner, {"command": "meeting-start", "title": " ".join(str(title or "").split())[:60]})
    return ("好的，已通知桌面端开始监控会议（约 10 秒内生效）。请确认 macOS 桌面端正在运行，"
            "并允许麦克风与屏幕/系统音频权限；会议结束后说「停止监控会议」，"
            "我会整理纪要并发送到指定邮箱。")


@tool(args_schema=MeetingStopArgs)
def meeting_stop() -> str:
    """结束会议监控：整理会议纪要并发送到指定邮箱。领导说「停止监控」「会议结束了」时使用。"""
    owner = current_owner_id()
    active = meeting.active_meetings.get(owner)
    meeting.desktop_commands.put(owner, {"command": "meeting-stop"})
    if active is None:
        return "当前没有正在监控的会议；已顺手通知桌面端停止（若它在采集中会立即结束）。"
    return ("收到，已通知桌面端结束会议监控；纪要整理好后会自动发送到指定邮箱"
            "（收件邮箱可在网页「⚙ API → 桌面与会议」修改）。")
