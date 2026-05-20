"""
tkinter 文件/文件夹选择弹窗
必须在主线程调用（PyInstaller 单文件 EXE 下无需额外处理）
"""
import tkinter as tk
from tkinter import filedialog

# 模块级共享 root：Windows 下反复 tk.Tk() + root.destroy() 会污染 Tcl 状态，
# 多次取消对话框后第 N 次 tk.Tk() 会阻塞主线程，导致 native_host 无回包，
# service worker 30s idle timeout 后 channel 关闭。
_shared_root = None


def _get_root() -> tk.Tk:
    global _shared_root
    if _shared_root is None:
        _shared_root = tk.Tk()
        _shared_root.withdraw()
    _shared_root.lift()
    _shared_root.attributes('-topmost', True)
    _shared_root.update_idletasks()
    return _shared_root


def ask_open_file(title: str, filetypes: list[tuple]) -> str:
    """弹出文件选择对话框，返回所选路径，取消返回空字符串。"""
    root = _get_root()
    path = filedialog.askopenfilename(
        parent=root,
        title=title,
        filetypes=filetypes + [('所有文件', '*.*')]
    )
    return path or ''


def ask_save_folder(title: str) -> str:
    """弹出文件夹选择对话框，返回所选路径，取消返回空字符串。"""
    root = _get_root()
    path = filedialog.askdirectory(parent=root, title=title)
    return path or ''
