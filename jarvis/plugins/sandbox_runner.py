"""第三方插件的子进程执行器：由 sandbox.py 用 ``python -I sandbox_runner.py <describe|call>`` 启动。

这个文件**只用标准库**、不导入 jarvis（独立解释器里不该有主进程的任何东西）。
请求从 stdin 读一行 JSON：{"dir": 插件目录, "entry": "tools.py", "tool": 工具名, "args": {...}, "limit": 秒}；
结果写成一行 JSON 到「原始 stdout」——插件代码自己的 print 被改道到 stderr，不会混进结果。

- describe → {"ok": true, "tools": [{"name", "description", "parameters"}]}
- call     → {"ok": true, "text": "..."} 或 {"ok": false, "error": "ExcType: 摘要"}
"""
import importlib.util
import inspect
import json
import os
import sys

MAX_TEXT = 8000
_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}


def _limit_resources(seconds):
    try:
        import resource
    except ImportError:   # 非 POSIX：只靠父进程的超时
        return
    cpu = max(2, int(seconds) + 1)
    limits = (("RLIMIT_CPU", cpu), ("RLIMIT_FSIZE", 20 * 1024 * 1024), ("RLIMIT_CORE", 0),
              ("RLIMIT_NOFILE", 256))
    if sys.platform.startswith("linux"):   # macOS 上 RLIMIT_AS / NPROC 语义不同，只在服务器（Linux）上收紧
        limits += (("RLIMIT_AS", 1024 * 1024 * 1024), ("RLIMIT_NPROC", 64))
    for name, value in limits:
        limit = getattr(resource, name, None)
        if limit is None:
            continue
        try:
            soft, hard = resource.getrlimit(limit)
            target = value if hard == resource.RLIM_INFINITY else min(value, hard)
            resource.setrlimit(limit, (target, hard))
        except (ValueError, OSError):
            pass


def _load(folder, entry):
    path = os.path.join(folder, entry)
    if not os.path.isfile(path):
        raise FileNotFoundError(entry)
    sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location("jarvis_plugin_entry", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["jarvis_plugin_entry"] = module
    spec.loader.exec_module(module)
    tools = getattr(module, "TOOLS", None)
    if not isinstance(tools, (list, tuple)):
        raise TypeError("TOOLS 不是列表")
    return tools


def _name(tool):
    return getattr(tool, "name", None) or getattr(tool, "__name__", "")


def _parameters(tool):
    schema = getattr(tool, "args_schema", None)
    if isinstance(schema, dict):
        return schema
    if schema is not None and hasattr(schema, "model_json_schema"):
        data = schema.model_json_schema()
        data.pop("title", None)
        return data
    if not callable(tool):
        return {"type": "object", "properties": {}}
    props, required = {}, []
    for pname, param in inspect.signature(tool).parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        props[pname] = {"type": _TYPES.get(param.annotation, "string")}
        if param.default is inspect.Parameter.empty:
            required.append(pname)
        else:
            props[pname]["default"] = param.default
    return {"type": "object", "properties": props, "required": required}


def _describe(tool):
    description = getattr(tool, "description", None) or inspect.getdoc(tool) or ""
    return {"name": _name(tool), "description": str(description)[:1000], "parameters": _parameters(tool)}


def _call(tool, args):
    if hasattr(tool, "invoke"):
        return tool.invoke(args)
    return tool(**args)


def _as_text(result):
    if isinstance(result, str):
        text = result
    else:
        content = getattr(result, "content", None)
        text = content if isinstance(content, str) else json.dumps(result, ensure_ascii=False, default=str)
    return text[:MAX_TEXT]


def main():
    out_fd = os.dup(1)
    os.dup2(2, 1)                       # 插件代码的 print / os.write(1) 一律进 stderr
    sys.stdout = sys.stderr
    try:
        request = json.loads(sys.stdin.readline() or "{}")
        _limit_resources(float(request.get("limit") or 20))
        os.chdir(request.get("workdir") or os.getcwd())
        tools = _load(request["dir"], request["entry"])
        mode = sys.argv[1] if len(sys.argv) > 1 else ""
        if mode == "describe":
            reply = {"ok": True, "tools": [_describe(tool) for tool in tools if _name(tool)]}
        elif mode == "call":
            target = next((tool for tool in tools if _name(tool) == request["tool"]), None)
            if target is None:
                reply = {"ok": False, "error": "ToolNotFound: 插件里没有这个工具"}
            else:
                reply = {"ok": True, "text": _as_text(_call(target, request.get("args") or {}))}
        else:
            reply = {"ok": False, "error": "BadMode"}
    except BaseException as exc:   # noqa: BLE001 —— 子进程里什么错都只回一行 JSON
        reply = {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    data = (json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8")
    while data:
        data = data[os.write(out_fd, data):]
    os.close(out_fd)


if __name__ == "__main__":
    main()
