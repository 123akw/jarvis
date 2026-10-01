"""飞书长连接帧编解码（pbbp2.Frame，proto2）。

字段定义取自飞书官方 Python SDK lark-oapi 1.7.3 的 ``lark_oapi/ws/pb/pbbp2_pb2.py``
描述符（长连接协议没有单独的公开文档，以官方 SDK 实现为准）::

    message Header { required string key = 1; required string value = 2; }
    message Frame {
      required uint64 SeqID = 1;   required uint64 LogID = 2;
      required int32  service = 3; required int32  method = 4;
      repeated Header headers = 5;
      optional string payload_encoding = 6; optional string payload_type = 7;
      optional bytes  payload = 8;          optional string LogIDNew = 9;
    }

整个协议只有这一个消息类型，手写编解码约 100 行，换来不引入 protobuf /
lark-oapi（后者安装后 46MB、一万余个文件）。tests/test_feishu_frame.py 用官方
SDK 序列化出的字节作为黄金向量锁定兼容性。
"""
from __future__ import annotations

from dataclasses import dataclass, field

METHOD_CONTROL = 0
METHOD_DATA = 1

_U64 = (1 << 64) - 1


class FrameError(ValueError):
    """帧字节不合法（截断、varint 超长或未知线型）。"""


def _varint(value: int) -> bytes:
    value &= _U64  # 负 int32 按 protobuf 规则符号扩展成 10 字节
    out = bytearray()
    while True:
        bits = value & 0x7F
        value >>= 7
        if value:
            out.append(bits | 0x80)
        else:
            out.append(bits)
            return bytes(out)


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise FrameError("truncated varint")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result & _U64, pos
    raise FrameError("varint too long")


def _field(number: int, payload: bytes) -> bytes:
    return _varint(number << 3 | 2) + _varint(len(payload)) + payload


def _int32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value - (1 << 32) if value >= 1 << 31 else value


def _fields(data: bytes):
    """逐个产出 (字段号, 线型, 值)；跳过未知字段时同样走这里。"""
    pos = 0
    while pos < len(data):
        key, pos = _read_varint(data, pos)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = _read_varint(data, pos)
        elif wire == 2:
            size, pos = _read_varint(data, pos)
            if pos + size > len(data):
                raise FrameError("truncated length-delimited field")
            value, pos = data[pos:pos + size], pos + size
        elif wire in (1, 5):
            width = 8 if wire == 1 else 4
            if pos + width > len(data):
                raise FrameError("truncated fixed field")
            value, pos = data[pos:pos + width], pos + width
        else:
            raise FrameError(f"unsupported wire type {wire}")
        yield number, wire, value


@dataclass
class Frame:
    seq_id: int = 0
    log_id: int = 0
    service: int = 0
    method: int = METHOD_CONTROL
    headers: list[tuple[str, str]] = field(default_factory=list)
    payload_encoding: str | None = None
    payload_type: str | None = None
    payload: bytes | None = None
    log_id_new: str | None = None

    def header(self, key: str, default: str | None = None) -> str | None:
        for name, value in self.headers:
            if name == key:
                return value
        return default

    def encode(self) -> bytes:
        out = bytearray()
        for number, value in ((1, self.seq_id), (2, self.log_id), (3, self.service), (4, self.method)):
            out += _varint(number << 3) + _varint(int(value))
        for key, value in self.headers:
            out += _field(5, _field(1, key.encode("utf-8")) + _field(2, value.encode("utf-8")))
        if self.payload_encoding is not None:
            out += _field(6, self.payload_encoding.encode("utf-8"))
        if self.payload_type is not None:
            out += _field(7, self.payload_type.encode("utf-8"))
        if self.payload is not None:
            out += _field(8, bytes(self.payload))
        if self.log_id_new is not None:
            out += _field(9, self.log_id_new.encode("utf-8"))
        return bytes(out)

    @classmethod
    def decode(cls, data: bytes) -> "Frame":
        frame = cls()
        try:
            for number, wire, value in _fields(bytes(data)):
                if number == 1 and wire == 0:
                    frame.seq_id = value
                elif number == 2 and wire == 0:
                    frame.log_id = value
                elif number == 3 and wire == 0:
                    frame.service = _int32(value)
                elif number == 4 and wire == 0:
                    frame.method = _int32(value)
                elif number == 5 and wire == 2:
                    key = val = ""
                    for inner_no, inner_wire, inner in _fields(value):
                        if inner_wire != 2:
                            continue
                        if inner_no == 1:
                            key = inner.decode("utf-8")
                        elif inner_no == 2:
                            val = inner.decode("utf-8")
                    frame.headers.append((key, val))
                elif number == 6 and wire == 2:
                    frame.payload_encoding = value.decode("utf-8")
                elif number == 7 and wire == 2:
                    frame.payload_type = value.decode("utf-8")
                elif number == 8 and wire == 2:
                    frame.payload = bytes(value)
                elif number == 9 and wire == 2:
                    frame.log_id_new = value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FrameError("invalid utf-8 in frame") from exc
        return frame


def ping_frame(service_id: int) -> Frame:
    """与官方 SDK ``_new_ping_frame`` 一致：CONTROL 帧 + type=ping。"""
    return Frame(service=service_id, method=METHOD_CONTROL, headers=[("type", "ping")])
