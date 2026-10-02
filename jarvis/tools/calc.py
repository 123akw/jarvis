"""计算器工具：ast 白名单求值，只认数字和四则/幂/取余运算，杜绝任意代码执行。"""
import ast
import math
import operator

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class CalcArgs(BaseModel):
    expression: str = Field(description="纯算术表达式，只含数字、+ - * / // % ** 和括号，"
                                        "如「(2300*12)*0.85」；不接受变量、函数或单位")


MAX_EXPRESSION_CHARS = 300   # 也顺带限住 AST 深度（1200 项连加会递归爆栈）
MAX_RESULT_DIGITS = 1000     # 整数结果位数上限：超大幂运算会长时间占住 GIL，冻住整个服务


class _TooLarge(ValueError):
    """结果超出可计算范围。"""


def _check_int_size(value):
    if isinstance(value, int) and value.bit_length() > MAX_RESULT_DIGITS * 3.33:
        raise _TooLarge()
    return value


def _safe_pow(base, exponent):
    """幂运算先估结果规模再算：9**9**9 这类表达式此前会把进程冻住一分钟以上。"""
    if isinstance(exponent, (int, float)) and abs(exponent) > 10_000:
        if not (isinstance(base, (int, float)) and abs(base) in (0, 1)):
            raise _TooLarge()
    if isinstance(base, int) and isinstance(exponent, int) and exponent > 0 and abs(base) > 1:
        if exponent * math.log10(abs(base)) > MAX_RESULT_DIGITS:
            raise _TooLarge()
    return operator.pow(base, exponent)


def _safe_mul(left, right):
    if isinstance(left, int) and isinstance(right, int):
        if left.bit_length() + right.bit_length() > MAX_RESULT_DIGITS * 3.33 + 2:
            raise _TooLarge()
    return operator.mul(left, right)


_BIN_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: _safe_mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: _safe_pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return _check_int_size(node.value)
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _check_int_size(_BIN_OPS[type(node.op)](_eval(node.left), _eval(node.right)))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_eval(node.operand))
    raise ValueError(f"不支持的表达式成分：{ast.dump(node)[:40]}")


def _format(result) -> str:
    if isinstance(result, float):
        if math.isinf(result) or math.isnan(result):
            raise _TooLarge()
        if result == int(result) and abs(result) < 1e15:
            return str(int(result))
    return str(result)


@tool(args_schema=CalcArgs)
def calc(expression: str) -> str:
    """精确计算算术表达式。凡是涉及数字运算都用它，不要心算。"""
    cleaned = expression.replace("×", "*").replace("÷", "/").replace("^", "**")
    if len(cleaned) > MAX_EXPRESSION_CHARS:
        return f"表达式太长了（上限 {MAX_EXPRESSION_CHARS} 个字符），请拆成几步分别计算。"
    try:
        return f"{expression} = {_format(_eval(ast.parse(cleaned, mode='eval').body))}"
    except ZeroDivisionError:
        return "除数为零，算不了。"
    except (_TooLarge, OverflowError):
        return "结果太大了，超出了可计算范围，请缩小数值或换个算法。"
    except (ValueError, SyntaxError, TypeError, RecursionError, MemoryError):
        return f"表达式「{expression}」看不懂，只支持数字和 + - * / // % ** 与括号。"
