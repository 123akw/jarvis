"""对话里「交给贾维斯」后台去办、建自动化（第二十一轮，归「任务」代理；契约 §5.3）。

计划中的工具：task_start / task_status / automation_add / automation_list / automation_remove。
地基为空列表；实现后把名字加进 jarvis/plugins/loader.py 的 BASE_TOOLS（智能体账号也能用）。
"""
TOOLS: list = []
