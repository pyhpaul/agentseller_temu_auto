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
import sys
import base64
import tempfile
import logging

BT_DLL     = r'C:\Program Files\Seagull\BarTender 2022\Seagull.BarTender.Print.dll'
NS_BARCODE = '具名条形码'
NS_SERIAL  = '具名序列号'
EXPORT_DPI = 1200

# 底图：background.png（空白盒子）
# 流程：标签按宽度比例等比缩放 → 居中放置（水平+垂直）
# 宽度比例参考 sample.jpg 中标签所占比例（约 0.483）
BG_FILENAME       = 'background.png'
LABEL_WIDTH_RATIO = 0.45
JPEG_QUALITY      = 92


def _resource_path(name: str) -> str:
    base = getattr(sys, '_MEIPASS', None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, 'resources', name)


def generate_label(skc_number: str, skc_sku: str, barcode_png_b64: str,
                   template_path: str, output_dir: str,
                   width_ratio: float = None) -> dict:
    if not template_path or not os.path.isfile(template_path):
        return {'success': False, 'error': f'模板文件不存在: {template_path}'}
    if not output_dir or not os.path.isdir(output_dir):
        return {'success': False, 'error': f'输出目录不存在: {output_dir}'}

    safe_stem = f'SKC-{skc_number}'.replace('/', '_').replace('\\', '_').replace(':', '_')
    sub_dir   = os.path.join(output_dir, safe_stem)
    os.makedirs(sub_dir, exist_ok=True)

    out_pdf        = os.path.join(sub_dir, f'{safe_stem}.pdf')
    out_raw_png    = os.path.join(sub_dir, f'{safe_stem}-raw.png')
    out_jpeg_final = os.path.join(sub_dir, f'{safe_stem}.jpeg')

    png_path = _save_b64_png(barcode_png_b64, skc_number)
    try:
        _run_bartender(template_path, png_path, skc_sku, out_pdf, out_raw_png)
        _composite_with_background(out_raw_png, out_jpeg_final, width_ratio=width_ratio)
    finally:
        _safe_remove(png_path)

    return {
        'success': True,
        'output_pdf': out_pdf,
        'output_png': out_jpeg_final,
        'output_raw': out_raw_png,
    }


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
                   out_pdf: str, out_png: str) -> None:
    """打开 BarTender 模板，写入数据，导出 600 DPI 的 PDF 和原始 PNG。"""
    import clr
    clr.AddReference(BT_DLL)
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
