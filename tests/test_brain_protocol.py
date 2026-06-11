# tests/test_brain_protocol.py — WS 消息编解码单测（对齐 js ws-client.js 的 encode 格式）。
from brain.protocol import encode, decode


def test_encode_basic():
    assert encode("PING", {}) == '{"type":"PING","data":{}}'


def test_encode_data_default():
    # data 缺省 → 空对象（对齐 js encode(type)）
    assert encode("PING") == '{"type":"PING","data":{}}'


def test_encode_with_data():
    assert encode("HELLO", {"role": "bg"}) == '{"type":"HELLO","data":{"role":"bg"}}'


def test_decode_roundtrip():
    t, d = decode(encode("STEP_RESULT", {"stepId": "ship", "status": "done"}))
    assert t == "STEP_RESULT"
    assert d == {"stepId": "ship", "status": "done"}


def test_decode_invalid_json():
    assert decode("not json") == (None, {})


def test_decode_missing_type():
    assert decode('{"data":{}}') == (None, {})


def test_decode_null_data():
    # data 为 null → 归一成空 dict
    assert decode('{"type":"PING","data":null}') == ("PING", {})
