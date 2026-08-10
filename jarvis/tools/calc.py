"""计算器工具：ast 白名单求值，只认数字和四则/幂/取余运算，杜绝任意代码执行。"""
import ast
import operator

from langchain_core.tools import tool

_BIN_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _BIN_OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_eval(node.operand))
    raise ValueError(f"不支持的表达式成分：{ast.dump(node)[:40]}")


@tool
def calc(expression: str) -> str:
    """计算一个算术表达式，支持 + - * / // % ** 和括号，例如「(2300*12)*0.85」。"""
    cleaned = expression.replace("×", "*").replace("÷", "/").replace("^", "**")
    try:
        result = _eval(ast.parse(cleaned, mode="eval").body)
    except ZeroDivisionError:
        return "除数为零，算不了。"
    except (ValueError, SyntaxError):
        return f"表达式「{expression}」看不懂，只支持数字和 + - * / // % ** 与括号。"
    if isinstance(result, float) and result == int(result) and abs(result) < 1e15:
        result = int(result)
    return f"{expression} = {result}"
