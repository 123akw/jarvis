"""测试夹具：最小的第三方插件。只用标准库 + langchain_core（导入方的解释器里有）。"""
import json
import os
import time

from langchain_core.tools import tool

from helper import shout   # 插件目录里的同级模块：子进程把插件目录放进 sys.path


@tool
def echo_shout(text: str) -> str:
    """把一句话变成大写并加感叹号。"""
    print("插件自己的 print 不该混进结果")
    return shout(text)


@tool
def echo_slow(seconds: float = 5) -> str:
    """睡一会儿再回答（测超时）。"""
    time.sleep(seconds)
    return "睡醒了"


@tool
def echo_crash() -> str:
    """直接让进程退出（测崩溃）。"""
    os._exit(3)


@tool
def echo_fail() -> str:
    """抛一个异常（测异常转人话）。"""
    raise ValueError("故意出错")


@tool
def echo_env() -> str:
    """列出子进程能看到的环境变量名（测最小环境）。"""
    return json.dumps(sorted(os.environ))


def echo_count(text: str, times: int = 2) -> str:
    """普通函数也能当工具：把文字重复几遍。"""
    return " ".join([text] * times)


TOOLS = [echo_shout, echo_slow, echo_crash, echo_fail, echo_env, echo_count]
