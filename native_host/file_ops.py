"""
通用文件操作 + 文件/文件夹选择对话框。

所有 feature 共用的 native 能力都放这里，与 auto_gen_label 专属的 BarTender 解耦。
tkinter 仅在弹对话框时惰性 import（放在 _get_root / dialog 函数内），这样 main.py /
file_ops.py 在没有 tkinter 的非 Windows 环境也能成功 import 自测。
"""
import os
import base64
import logging

# 默认分块大小（与 Chrome Native Messaging 单消息 1MB 上限对齐）
DEFAULT_CHUNK_LENGTH = 524288


# ── 文件读取 ──────────────────────────────────────────────────────────────────

def read_file(msg: dict) -> dict:
    """读完整文件 base64。出参 {success, data}。"""
    path = msg.get('path', '')
    if not path or not os.path.isfile(path):
        return {'success': False, 'error': f'文件不存在: {path}'}
    with open(path, 'rb') as f:
        data = base64.b64encode(f.read()).decode('utf-8')
    return {'success': True, 'data': data}


def read_file_size(msg: dict) -> dict:
    """取文件大小。出参 {success, size}。"""
    path = msg.get('path', '')
    if not path or not os.path.isfile(path):
        return {'success': False, 'error': f'文件不存在: {path}'}
    return {'success': True, 'size': os.path.getsize(path)}


def read_file_chunk(msg: dict) -> dict:
    """分块读取（>1MB 文件用）。出参 {success, data}。"""
    path = msg.get('path', '')
    offset = int(msg.get('offset', 0))
    length = int(msg.get('length', DEFAULT_CHUNK_LENGTH))
    if not path or not os.path.isfile(path):
        return {'success': False, 'error': f'文件不存在: {path}'}
    with open(path, 'rb') as f:
        f.seek(offset)
        data = base64.b64encode(f.read(length)).decode('utf-8')
    return {'success': True, 'data': data}


# ── 文件写入（分块）────────────────────────────────────────────────────────────

def write_file_chunk(msg: dict) -> dict:
    """通用分块写文件，read_file_chunk 的反向。

    入参：path（目标绝对路径）/ data（本块字节 base64）/ offset（字节偏移）/ done（是否最后一块）。
    语义：offset==0 时创建/截断文件再写；其余 offset 按位置写入（'r+b' + seek）。
    出参：写中间块 {success, bytes_written}；done=True 时 {success, path, size}。失败 {success: False, error}。
    """
    path = msg.get('path', '')
    if not path:
        return {'success': False, 'error': 'path 字段为空'}
    offset = int(msg.get('offset', 0))
    done = bool(msg.get('done', False))
    raw = msg.get('data', '')
    try:
        chunk = base64.b64decode(raw) if raw else b''
    except Exception as e:
        return {'success': False, 'error': f'data 不是合法 base64: {e}'}

    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        return {'success': False, 'error': f'目标目录不存在: {parent}'}

    try:
        if offset == 0:
            # 首块：截断创建，从头写
            with open(path, 'wb') as f:
                f.write(chunk)
        else:
            # 后续块：定位到 offset 写入（文件须已由首块创建）
            with open(path, 'r+b') as f:
                f.seek(offset)
                f.write(chunk)
    except OSError as e:
        return {'success': False, 'error': f'写入失败: {e}'}

    bytes_written = len(chunk)
    logging.info('write_file_chunk: %s offset=%d bytes=%d done=%s', path, offset, bytes_written, done)
    if done:
        return {'success': True, 'path': path, 'size': os.path.getsize(path)}
    return {'success': True, 'bytes_written': bytes_written}


# ── 文件/文件夹选择对话框（tkinter 惰性 import）─────────────────────────────────

# 模块级共享 root：Windows 下反复 tk.Tk() + root.destroy() 会污染 Tcl 状态，
# 多次取消对话框后第 N 次 tk.Tk() 会阻塞主线程，导致 native_host 无回包，
# service worker 30s idle timeout 后 channel 关闭。
_shared_root = None


def _get_root():
    """惰性创建并复用 tkinter root。tkinter 仅在此处 import，
    保证非 Windows / 无 tkinter 环境下 import file_ops 不报错。"""
    global _shared_root
    import tkinter as tk  # 惰性 import：仅弹对话框时才需要
    if _shared_root is None:
        _shared_root = tk.Tk()
        _shared_root.withdraw()
    _shared_root.lift()
    _shared_root.attributes('-topmost', True)
    _shared_root.update_idletasks()
    return _shared_root


def _normalize_filetypes(raw) -> list:
    if not raw:
        return []
    return [tuple(item) for item in raw]


def ask_open_file(title: str, filetypes: list) -> str:
    """弹出文件选择对话框，返回所选路径，取消返回空字符串。"""
    from tkinter import filedialog
    root = _get_root()
    path = filedialog.askopenfilename(
        parent=root,
        title=title,
        filetypes=filetypes + [('所有文件', '*.*')]
    )
    return path or ''


def ask_save_folder(title: str) -> str:
    """弹出文件夹选择对话框，返回所选路径，取消返回空字符串。"""
    from tkinter import filedialog
    root = _get_root()
    path = filedialog.askdirectory(parent=root, title=title)
    return path or ''


def pick_file(msg: dict) -> dict:
    """文件选择对话框。出参 {success, path} 或 {success: False, error}。"""
    path = ask_open_file(
        title=msg.get('title', '选择文件'),
        filetypes=_normalize_filetypes(msg.get('filetypes'))
    )
    if not path:
        return {'success': False, 'error': '用户取消'}
    return {'success': True, 'path': path}


def pick_folder(msg: dict) -> dict:
    """文件夹选择对话框。出参 {success, path} 或 {success: False, error}。"""
    path = ask_save_folder(title=msg.get('title', '选择文件夹'))
    if not path:
        return {'success': False, 'error': '用户取消'}
    return {'success': True, 'path': path}
