"""飞书长连接帧编解码：以官方 SDK（lark-oapi 1.7.3 自带 protobuf）序列化出的字节为黄金向量。"""
import pytest

from jarvis.channels.feishu.frame import METHOD_CONTROL, METHOD_DATA, Frame, FrameError, ping_frame

# 生成方式：lark_oapi.ws.pb.pbbp2_pb2.Frame 按注释字段赋值后 SerializeToString().hex()
GOLDEN_PING = "0800100018b96020002a0c0a0474797065120470696e67"
GOLDEN_DATA = (
    "080710cb89ec8ff723182a20012a0d0a047479706512056576656e742a130a0a6d6573736167655f696412056d73672d31"
    "2a080a0373756d1201312a080a037365711201302a100a0874726163655f6964120474722d31422b7b22736368656d61223a"
    "22322e30222c22686561646572223a7b226576656e745f6964223a226531227d7d4a096c6f6769642d6e6577"
)
GOLDEN_EDGE = "0885808080808080808001100118ffffffffffffffffff0120013204677a69703a046a736f6e4200"


def test_ping_frame_matches_official_sdk_bytes():
    """防回归：心跳帧必须与官方 SDK _new_ping_frame(12345) 逐字节一致。"""
    assert ping_frame(12345).encode().hex() == GOLDEN_PING


def test_data_frame_decodes_and_reencodes_byte_identical():
    frame = Frame.decode(bytes.fromhex(GOLDEN_DATA))

    assert (frame.seq_id, frame.log_id, frame.service, frame.method) == (7, 1234567890123, 42, METHOD_DATA)
    assert frame.headers == [("type", "event"), ("message_id", "msg-1"), ("sum", "1"), ("seq", "0"),
                             ("trace_id", "tr-1")]
    assert frame.header("trace_id") == "tr-1" and frame.header("missing", "d") == "d"
    assert frame.payload == b'{"schema":"2.0","header":{"event_id":"e1"}}'
    assert frame.log_id_new == "logid-new"
    assert frame.encode().hex() == GOLDEN_DATA


def test_edge_values_negative_int32_big_uint64_and_empty_payload():
    """负 int32 符号扩展成 10 字节 varint；空 payload 也要原样保留（optional 已设置）。"""
    frame = Frame.decode(bytes.fromhex(GOLDEN_EDGE))

    assert frame.seq_id == 2**63 + 5 and frame.service == -1
    assert frame.payload_encoding == "gzip" and frame.payload_type == "json"
    assert frame.payload == b"" and frame.log_id_new is None
    assert frame.encode().hex() == GOLDEN_EDGE


def test_unknown_fields_are_skipped():
    known = ping_frame(1).encode()
    unknown = bytes([0x50, 0x05]) + bytes([0x5D, 1, 2, 3, 4]) + bytes([0x61]) + bytes(8)  # 字段 10/11/12
    frame = Frame.decode(known + unknown)
    assert frame.method == METHOD_CONTROL and frame.header("type") == "ping"


@pytest.mark.parametrize("raw", [b"\x08", b"\x08\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\x01",
                                 b"\x42\x05ab", b"\x0b"])
def test_malformed_bytes_raise_frame_error(raw):
    with pytest.raises(FrameError):
        Frame.decode(raw)
