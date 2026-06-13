"""
BarTender 2022 标签生成 - 使用 .NET SDK (pythonnet)
依赖：pythonnet >= 3.0, Pillow, Seagull.BarTender.Print.dll

模板 NamedSubStrings（经实测确认）：
  具名条形码 → 本地 PNG 文件路径
  具名序列号 → SKC货号字符串

导出参数（经实测确认）：
  Resolution(600)            → 600 DPI，1890×1417 像素（80×60mm 模板）
  ImageType.PNG              → PNG 格式（= 3）
  ImageType.PDF              → PDF 格式（= 35）
  ColorDepth.ColorDepth24bit → 24-bit 真彩色（= 4）
  OverwriteOptions.Overwrite → 覆盖已有文件（= 2）
"""
import os
import re
import sys
import base64
import tempfile
import logging
from typing import Optional

# Windows 文件名/目录名非法字符（含路径分隔符、盘符冒号、通配等）统一替换为下划线
_WIN_ILLEGAL = re.compile(r'[\\/:*?"<>|]')


def _safe_name(s: str) -> str:
    return _WIN_ILLEGAL.sub('_', s)

# DLL 查找优先级：环境变量 TEMU_LABEL_BT_DLL → Program Files → Program Files (x86)
# 第一个存在的即用。员工把 BarTender 装到非默认目录时设置环境变量覆盖即可
BT_DLL_ENV_VAR = 'TEMU_LABEL_BT_DLL'
BT_DLL_CANDIDATES = [
    r'C:\Program Files\Seagull\BarTender 2022\Seagull.BarTender.Print.dll',
    r'C:\Program Files (x86)\Seagull\BarTender 2022\Seagull.BarTender.Print.dll',
]
NS_BARCODE = '具名条形码'
NS_SERIAL  = '具名序列号'
EXPORT_DPI = 1200


def resolve_bt_dll() -> Optional[str]:
    """按优先级查找 BarTender DLL。找到第一个存在的返回完整路径，否则 None。"""
    env_path = os.environ.get(BT_DLL_ENV_VAR)
    if env_path and os.path.isfile(env_path):
        return env_path
    for path in BT_DLL_CANDIDATES:
        if os.path.isfile(path):
            return path
    return None

# 底图：background.png（空白盒子）
# 流程：标签按宽度比例等比缩放 → 居中放置（水平+垂直）
# 宽度比例参考 sample.jpg 中标签所占比例（约 0.483）
BG_FILENAME       = 'background.png'
LABEL_WIDTH_RATIO = 0.45
JPEG_QUALITY      = 92


def _resource_path(name: str) -> str:
    # 冻结(EXE)：资源经 build.bat 的 --add-data 打到 _MEIPASS/resources/，直接用 _MEIPASS。
    # dev：bartender.py 在 native_host/handlers/，但 resources 在 native_host/resources/，
    #      需从 __file__ 上溯两层（handlers/bartender.py → handlers/ → native_host/）。
    base = getattr(sys, '_MEIPASS', None) or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, 'resources', name)


def generate_label(skc_number: str, skc_sku: str, barcode_png_b64: str,
                   template_path: str, output_dir: str,
                   width_ratio: float = None) -> dict:
    if not template_path or not os.path.isfile(template_path):
        return {'success': False, 'error': f'模板文件不存在: {template_path}'}
    if not output_dir or not os.path.isdir(output_dir):
        return {'success': False, 'error': f'输出目录不存在: {output_dir}'}
    bt_dll = resolve_bt_dll()
    if not bt_dll:
        env_hint = os.environ.get(BT_DLL_ENV_VAR)
        env_msg = f'（环境变量 {BT_DLL_ENV_VAR} 当前值: {env_hint!r}，文件不存在）' if env_hint else ''
        return {
            'success': False,
            'error': (
                f'未找到 BarTender DLL（Seagull.BarTender.Print.dll）。'
                f'请确认已安装 BarTender 2022，或设置环境变量 {BT_DLL_ENV_VAR} 指向该 DLL 完整路径。'
                f' 已尝试默认路径: {" / ".join(BT_DLL_CANDIDATES)}{env_msg}'
            ),
        }

    # 命名规则改进：
    # 文件夹：SKC ID - SKC货号基础部分（如 12345-CLI319）
    #        SKC货号可能含属性（如 CLI319-White-2pcs），此处提取基础部分（CLI319）
    # 文件：SKU货号完整形式（如 CLI319-White-2pcs）
    skc_sku_base = skc_sku.split('-')[0] if skc_sku else ''
    folder_name = f'{skc_number}-{skc_sku_base}' if skc_sku_base else str(skc_number)
    folder_safe = _safe_name(folder_name)
    sub_dir = os.path.join(output_dir, folder_safe)
    os.makedirs(sub_dir, exist_ok=True)

    file_stem = skc_sku if skc_sku else f'label-{skc_number}'
    file_safe = _safe_name(file_stem)

    out_pdf        = os.path.join(sub_dir, f'{file_safe}.pdf')
    out_raw_png    = os.path.join(sub_dir, f'{file_safe}-raw.png')
    out_jpeg_final = os.path.join(sub_dir, f'{file_safe}.jpeg')

    png_path = _save_b64_png(barcode_png_b64, skc_number)
    try:
        _run_bartender(template_path, png_path, skc_sku, out_pdf, out_raw_png, bt_dll)
        _composite_with_background(out_raw_png, out_jpeg_final, width_ratio=width_ratio)
    finally:
        _safe_remove(png_path)

    return {
        'success': True,
        'output_pdf': out_pdf,
        'output_png': out_jpeg_final,
        'output_raw': out_raw_png,
    }


def handle(msg: dict) -> dict:
    """native action 'generate_label' 的入口：把 msg 映射到 generate_label。
    入参/出参与重构前完全一致。"""
    return generate_label(
        skc_number=msg['skc_number'],
        skc_sku=msg['skc_sku'],
        barcode_png_b64=msg['barcode_png_b64'],
        template_path=msg['template_path'],
        output_dir=msg['output_dir'],
        width_ratio=msg.get('width_ratio')
    )


def _save_b64_png(b64_data: str, name_hint: str) -> str:
    """将 base64 PNG 字符串写入临时文件，返回 Windows 绝对路径。"""
    if ',' in b64_data:
        b64_data = b64_data.split(',', 1)[1]
    img_bytes = base64.b64decode(b64_data)
    tmp = tempfile.NamedTemporaryFile(
        suffix='.png', prefix=f'barcode_{name_hint}_', delete=False
    )
    tmp.write(img_bytes)
    tmp.close()
    logging.info('条形码 PNG 已保存: %s', tmp.name)
    return tmp.name


def _run_bartender(btw_path: str, png_path: str, skc_sku: str,
                   out_pdf: str, out_png: str, bt_dll: str) -> None:
    """打开 BarTender 模板，写入数据，导出 600 DPI 的 PDF 和原始 PNG。"""
    import clr
    clr.AddReference(bt_dll)
    from Seagull.BarTender.Print import (
        Engine, ImageType, ColorDepth,
        OverwriteOptions, SaveOptions, Resolution
    )

    engine = Engine(False)
    engine.Start()
    logging.info('BarTender Engine 启动')

    try:
        fmt = engine.Documents.Open(btw_path)

        fmt.SubStrings[NS_BARCODE].Value = png_path
        fmt.SubStrings[NS_SERIAL].Value  = skc_sku
        logging.info('SubStrings 写入完成: %s / %s', NS_BARCODE, NS_SERIAL)

        res = Resolution(EXPORT_DPI)
        fmt.ExportImageToFile(out_pdf, ImageType.PDF, ColorDepth.ColorDepth24bit, res, OverwriteOptions.Overwrite)
        fmt.ExportImageToFile(out_png, ImageType.PNG, ColorDepth.ColorDepth24bit, res, OverwriteOptions.Overwrite)

        logging.info('导出完成 %d DPI: %s, %s', EXPORT_DPI, out_pdf, out_png)
    finally:
        try:
            fmt.Close(SaveOptions.DoNotSaveChanges)
        except Exception:
            pass
        engine.Stop()
        logging.info('BarTender Engine 停止')


def _composite_with_background(label_png: str, out_path: str,
                               width_ratio: float = None) -> None:
    """将 BarTender 标签 PNG 等比缩放后居中粘贴到 background.png。"""
    from PIL import Image

    ratio = width_ratio if width_ratio else LABEL_WIDTH_RATIO

    bg_path = _resource_path(BG_FILENAME)
    if not os.path.isfile(bg_path):
        raise FileNotFoundError(f'底图资源缺失: {bg_path}')

    bg    = Image.open(bg_path).convert('RGB')
    label = Image.open(label_png).convert('RGB')

    target_w = int(bg.width * ratio)
    scale    = target_w / label.width
    target_h = int(label.height * scale)
    label    = label.resize((target_w, target_h), Image.LANCZOS)

    paste_x = (bg.width  - target_w) // 2
    paste_y = (bg.height - target_h) // 2
    bg.paste(label, (paste_x, paste_y))

    bg.save(out_path, 'JPEG', quality=JPEG_QUALITY, optimize=True)
    logging.info('合成完成: ratio=%.3f 标签 %dx%d 贴到底图 %dx%d 位置(%d,%d) → %s',
                 ratio, target_w, target_h, bg.width, bg.height, paste_x, paste_y, out_path)


def _safe_remove(path: str):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
