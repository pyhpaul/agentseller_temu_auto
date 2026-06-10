"""
build_extension.py — 把 core/ 和 features 内容聚合到 dist/extension/。
v1：仅 core 资产拷贝；feature 扫描在 Task 7 加入。
"""
import datetime
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / 'core'
FEATURES_DIR = ROOT / 'features'
DIST = ROOT / 'dist' / 'extension'


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


def copy_dashboard_assets():
    """拷贝 core/dashboard/ 整个子树 → dist/extension/dashboard/，并给各 .js 注 sourceURL。
    dashboard 是 ES module 扩展页，不走 content_scripts 注入，故与 copy_core_assets 的
    background/content/popup/icons 分开处理（那批是 content script + popup 资产）。
    """
    src = CORE / 'dashboard'
    if not src.exists():
        return
    dst = DIST / 'dashboard'
    shutil.copytree(src, dst)
    for js in dst.rglob('*.js'):
        rel_to_root = (src / js.relative_to(dst)).relative_to(ROOT)
        _inject_source_url(js, str(rel_to_root))
    n = sum(1 for _ in dst.rglob('*') if _.is_file())
    print(f'[build] dashboard/ → dist/extension/dashboard/  ({n} files)')


def copy_core_root_files():
    """拷贝 core/ 根级共享文件（contract.js 等）→ dist/extension/。
    这些是 bg + dashboard 共用的契约模块（不属 background/content/popup/dashboard 任一子目录），
    单独拷到 dist 根级；SW importScripts('../contract.js')、dashboard <script src="../contract.js"> 共用。
    """
    for name in ['contract.js']:
        src = CORE / name
        if not src.exists():
            continue
        dst = DIST / name
        shutil.copy2(src, dst)
        _inject_source_url(dst, str(src.relative_to(ROOT)))
        print(f'[build] {name} → dist/extension/{name}')


def scan_features():
    """扫描 features/*/feature.json，返回 feature 元数据列表。"""
    features = []
    if not FEATURES_DIR.exists():
        return features
    for entry in sorted(FEATURES_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith('.'):
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


def emit_build_info():
    """生成 content/build-info.js，注入 window.__AS_BUILD_INFO__ = { ts, isDev, version }。
    dev 默认 isDev=true / version='dev'；release 由 package_all.py 用 string replace 改成
    isDev=false 并从 installer.iss 读真实版本号写入 version。
    UI 显示：dev 模式 dev:<ts>；release 模式 v<version>（员工自助查版本号）。
    """
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    content = f"window.__AS_BUILD_INFO__ = {{ ts: '{ts}', isDev: true, version: 'dev' }};\n"
    dst = DIST / 'content' / 'build-info.js'
    dst.write_text(content, encoding='utf-8')
    print(f'[build] build-info.js generated  ts={ts} isDev=true version=dev')


def render_manifest(features=None):
    """读模板 → 替换占位符 → 写 dist/extension/manifest.json。
    v1 features=None，仅写 core 的 content_scripts 占位（空数组）。
    """
    features = features or []
    template = json.loads((CORE / 'manifest.template.json').read_text(encoding='utf-8'))

    # storage 由 core 显式声明：orchestrator bg + overlay content script 都依赖 storage.local/onChanged，
    # 不靠 feature.json 偶然聚合带入（避免「未来删 feature 致 core 组件静默失效」）。同 windows（dashboard 依赖）。
    permissions = sorted({'nativeMessaging', 'windows', 'storage', *(p for f in features for p in f.get('permissions', []))})
    host_permissions = sorted({h for f in features for h in f.get('host_permissions', [])})
    content_script_matches = collect_content_matches(features)
    extra_cs = collect_extra_content_scripts(features)
    # build-info.js 必须最先注入，让 ui.js 能读到 window.__AS_BUILD_INFO__
    content_scripts_js = (
        # overlay.js（编排消费端 HITL 浮层）插 registry 后 core 前：归入 core 体系；自驱 IIFE 不依赖加载顺序
        ['content/build-info.js', 'content/utils.js', 'content/ui.js', 'content/registry.js', 'content/overlay.js', 'content/core.js']
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
    copy_core_root_files()          # ← 新增：拷 core 根级共享 contract.js
    copy_dashboard_assets()
    emit_build_info()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')


if __name__ == '__main__':
    build_all()
