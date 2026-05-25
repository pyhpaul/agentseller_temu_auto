"""
Native Messaging Host 入口（所有 feature 共用的顶层 native host）。
Chrome 通过 stdin/stdout 通信：4 字节小端序长度前缀 + UTF-8 JSON。

main.py 保持薄：只做协议 IO + 按 action 分发。通用文件能力在 file_ops.py；
feature 专属、依赖重的 handler（如 auto_gen_label 的 bartender，需 pythonnet + .NET SDK）
惰性 import，保证在没有 BarTender/pythonnet/tkinter 的非 Windows 环境也能 import main 自测。
"""
import sys
import json
import struct
import logging

import file_ops

logging.basicConfig(
    filename='temu_label_host.log',
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode('utf-8'))


def send_message(payload: dict):
    encoded = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _generate_label(msg: dict) -> dict:
    """auto_gen_label 专属，惰性 import bartender（依赖 pythonnet + BarTender，Windows-only）。"""
    from handlers import bartender
    return bartender.handle(msg)


# action → handler(msg) -> dict。所有 handler 入参为完整 msg dict，出参为返回给 Chrome 的 dict。
# 通用文件能力走 file_ops；feature 专属 handler（generate_label）惰性 import。
DISPATCH = {
    'generate_label': _generate_label,
    'pick_file': file_ops.pick_file,
    'pick_folder': file_ops.pick_folder,
    'read_file': file_ops.read_file,
    'read_file_size': file_ops.read_file_size,
    'read_file_chunk': file_ops.read_file_chunk,
    'write_file_chunk': file_ops.write_file_chunk,
}


def handle(msg: dict) -> dict:
    action = msg.get('action')
    fn = DISPATCH.get(action)
    if fn is None:
        return {'success': False, 'error': f'未知 action: {action}'}
    return fn(msg)


def main():
    logging.info('Native Host 启动')
    while True:
        msg = read_message()
        if msg is None:
            logging.info('stdin 关闭，退出')
            break
        logging.info('收到消息: %s', msg.get('action'))
        try:
            response = handle(msg)
        except Exception as e:
            logging.exception('处理消息异常')
            response = {'success': False, 'error': str(e)}
        send_message(response)


if __name__ == '__main__':
    main()
