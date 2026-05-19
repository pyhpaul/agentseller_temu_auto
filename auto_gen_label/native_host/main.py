"""
Native Messaging Host 入口
Chrome 通过 stdin/stdout 通信：4 字节小端序长度前缀 + UTF-8 JSON
"""
import sys
import json
import struct
import logging

from bartender_handler import generate_label
from file_dialog import ask_open_file, ask_save_folder

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


def _normalize_filetypes(raw) -> list:
    if not raw:
        return []
    return [tuple(item) for item in raw]


def handle(msg: dict) -> dict:
    action = msg.get('action')
    if action == 'generate_label':
        return generate_label(
            skc_number=msg['skc_number'],
            skc_sku=msg['skc_sku'],
            barcode_png_b64=msg['barcode_png_b64'],
            template_path=msg['template_path'],
            output_dir=msg['output_dir'],
            width_ratio=msg.get('width_ratio')
        )
    if action == 'pick_file':
        path = ask_open_file(
            title=msg.get('title', '选择文件'),
            filetypes=_normalize_filetypes(msg.get('filetypes'))
        )
        if not path:
            return {'success': False, 'error': '用户取消'}
        return {'success': True, 'path': path}
    if action == 'pick_folder':
        path = ask_save_folder(title=msg.get('title', '选择文件夹'))
        if not path:
            return {'success': False, 'error': '用户取消'}
        return {'success': True, 'path': path}
    if action == 'read_file':
        import os, base64
        path = msg.get('path', '')
        if not path or not os.path.isfile(path):
            return {'success': False, 'error': f'文件不存在: {path}'}
        with open(path, 'rb') as f:
            data = base64.b64encode(f.read()).decode('utf-8')
        return {'success': True, 'data': data}
    if action == 'read_file_size':
        import os
        path = msg.get('path', '')
        if not path or not os.path.isfile(path):
            return {'success': False, 'error': f'文件不存在: {path}'}
        return {'success': True, 'size': os.path.getsize(path)}
    if action == 'read_file_chunk':
        import os, base64
        path = msg.get('path', '')
        offset = int(msg.get('offset', 0))
        length = int(msg.get('length', 524288))
        if not path or not os.path.isfile(path):
            return {'success': False, 'error': f'文件不存在: {path}'}
        with open(path, 'rb') as f:
            f.seek(offset)
            data = base64.b64encode(f.read(length)).decode('utf-8')
        return {'success': True, 'data': data}
    return {'success': False, 'error': f'未知 action: {action}'}


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
