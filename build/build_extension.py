"""
build_extension.py — 把 core/ 和 features 内容聚合到 dist/extension/。
v1：仅 core 资产拷贝；feature 扫描在 Task 7 加入。
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / 'core'
DIST = ROOT / 'dist' / 'extension'

SKIP_DIRS = {'core', 'build', 'dist', 'docs', '__pycache__', '.git'}


def _inject_source_url(dst_file: Path, src_rel: str):
    """在 .js 文件末尾追加 //# sourceURL=<src_rel> 注释，让 DevTools 按源路径展示。"""
    if dst_file.suffix != '.js':
        return
    content = dst_file.read_text(encoding='utf-8')
    if '//# sourceURL=' in content:
        return  # 幂等
    dst_file.write_text(content.rstrip() + f'\n//# sourceURL={src_rel}\n', encoding='utf-8')


def clean_dist():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True, exist_ok=True)


def copy_core_assets():
    """拷贝 core/{background,content,popup,icons} → dist/extension/{...}"""
    for sub in ['background', 'content', 'popup', 'icons']:
        src = CORE / sub
        if not src.exists():
            continue
        dst = DIST / sub
        shutil.copytree(src, dst)
        for js in dst.rglob('*.js'):
            rel_to_root = (src / js.relative_to(dst)).relative_to(ROOT)
            _inject_source_url(js, str(rel_to_root))
        print(f'[build] {sub}/ → dist/extension/{sub}/  ({sum(1 for _ in dst.rglob("*") if _.is_file())} files)')


def scan_features():
    """扫描 <ROOT>/*/feature.json，返回 feature 元数据列表。"""
    features = []
    for entry in sorted(ROOT.iterdir()):
        if not entry.is_dir() or entry.name in SKIP_DIRS or entry.name.startswith('.'):
            continue
        fjson = entry / 'feature.json'
        if not fjson.exists():
            continue
        meta = json.loads(fjson.read_text(encoding='utf-8'))
        meta['_dir'] = entry  # 内部字段，记录源目录
        features.append(meta)
        print(f'[build] discovered feature: {meta["id"]}')
    return features


def collect_content_matches(features):
    """聚合各 feature 的 content_matches（缺省回退到 host_permissions），结果排序去重。"""
    return sorted({
        m
        for f in features
        for m in f.get('content_matches', f.get('host_permissions', []))
    })


def collect_extra_content_scripts(features):
    """收集所有 feature 的 extra_content_scripts，将 js 路径补全为 features/<id>/<path>。"""
    result = []
    for f in features:
        for ecs in f.get('extra_content_scripts', []):
            js_list = ecs.get('js', [])
            if not js_list:
                print(f'[warn] feature {f["id"]}: extra_content_scripts entry has no js files')
                ecs_copy = dict(ecs)
                result.append(ecs_copy)
                continue
            ecs_copy = dict(ecs)
            ecs_copy['js'] = [f'features/{f["id"]}/{js}' for js in js_list]
            result.append(ecs_copy)
    return result


def copy_feature_assets(features):
    """拷贝每个 feature 的 content_script 到 dist/extension/features/<id>/"""
    for f in features:
        src_dir = f['_dir']
        src_script = src_dir / f['content_script']
        dst_script = DIST / 'features' / f['id'] / f['content_script']
        dst_script.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_script, dst_script)
        rel = src_script.relative_to(ROOT)
        _inject_source_url(dst_script, str(rel))
        print(f'[build] {rel} → dist/extension/features/{f["id"]}/{f["content_script"]}')


def copy_extra_cs_assets(features):
    """拷贝 extra_content_scripts 引用的 js 文件和 extra_assets 到 dist/extension/features/<id>/。"""
    for f in features:
        src_dir = f['_dir']
        for ecs in f.get('extra_content_scripts', []):
            for js_path in ecs.get('js', []):
                src = src_dir / js_path
                if not src.exists():
                    raise FileNotFoundError(f'[build] extra_content_script not found: {src}')
                dst = DIST / 'features' / f['id'] / js_path
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                rel = src.relative_to(ROOT)
                _inject_source_url(dst, str(rel))
                print(f'[build] extra cs: {rel} → dist/extension/features/{f["id"]}/{js_path}')
        for asset_path in f.get('extra_assets', []):
            src = src_dir / asset_path
            if not src.exists():
                raise FileNotFoundError(f'[build] extra_asset not found: {src}')
            dst = DIST / 'features' / f['id'] / asset_path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            rel = src.relative_to(ROOT)
            _inject_source_url(dst, str(rel))
            print(f'[build] extra asset: {rel} → dist/extension/features/{f["id"]}/{asset_path}')


def render_manifest(features=None):
    """读模板 → 替换占位符 → 写 dist/extension/manifest.json。
    v1 features=None，仅写 core 的 content_scripts 占位（空数组）。
    """
    features = features or []
    template = json.loads((CORE / 'manifest.template.json').read_text(encoding='utf-8'))

    permissions = sorted({'nativeMessaging', *(p for f in features for p in f.get('permissions', []))})
    host_permissions = sorted({h for f in features for h in f.get('host_permissions', [])})
    content_script_matches = collect_content_matches(features)
    extra_cs = collect_extra_content_scripts(features)
    content_scripts_js = (
        ['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js']
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
    )

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = content_script_matches
    template['content_scripts'][0]['js'] = content_scripts_js
    for ecs in extra_cs:
        template['content_scripts'].append(ecs)

    (DIST / 'manifest.json').write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[build] manifest.json generated  ({len(features)} features, {len(content_scripts_js)} content scripts)')


def build_all():
    clean_dist()
    copy_core_assets()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')


if __name__ == '__main__':
    build_all()
