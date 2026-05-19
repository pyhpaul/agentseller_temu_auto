"""
tkinter 文件/文件夹选择弹窗
必须在主线程调用（PyInstaller 单文件 EXE 下无需额外处理）
"""
import tkinter as tk
from tkinter import filedialog


def _root():
    root = tk.Tk()
    root.withdraw()          # 隐藏主窗口
    root.lift()
    root.attributes('-topmost', True)
    return root


def ask_open_file(title: str, filetypes: list[tuple]) -> str:
    """弹出文件选择对话框，返回所选路径，取消返回空字符串。"""
    root = _root()
    path = filedialog.askopenfilename(
        parent=root,
        title=title,
        filetypes=filetypes + [('所有文件', '*.*')]
    )
    root.destroy()
    return path or ''


def ask_save_folder(title: str) -> str:
    """弹出文件夹选择对话框，返回所选路径，取消返回空字符串。"""
    root = _root()
    path = filedialog.askdirectory(parent=root, title=title)
    root.destroy()
    return path or ''
