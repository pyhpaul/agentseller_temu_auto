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
AUTOMATION = ROOT / 'automation'
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


def assemble_automation(with_automation: bool):
    """装配 automation/ 到 dist（dev 默认 True；release 传 False → 跳过，产物纯 hub）。
    返回 content_scripts 注入位 + manifest fragment；automation/ 不存在亦跳过（幂等）。

    装配位置决定 importScripts 运行时路径：bg 资产落 dist/background/（与 SW 同级），故
    automation/bg-entry.js 里 importScripts('../contract.js','orchestrator/*.js','ws-client.js')
    的相对路径与原 SW 完全一致。dashboard 落 dist 根 dashboard/（getURL 路径不变）。
    """
    if not with_automation or not AUTOMATION.exists():
        print('[build] automation/ 未装配（release 或目录缺失）')
        return {'pre_core': [], 'post_core': [], 'fragment': {}}
    # bg 资产 → dist/background/（与 SW 同级，复现 importScripts 相对路径）
    (DIST / 'background').mkdir(parents=True, exist_ok=True)
    shutil.copy2(AUTOMATION / 'bg-entry.js', DIST / 'background' / 'automation-bg-entry.js')
    shutil.copytree(AUTOMATION / 'orchestrator', DIST / 'background' / 'orchestrator')
    shutil.copy2(AUTOMATION / 'brain-bridge' / 'ws-client.js', DIST / 'background' / 'ws-client.js')
    shutil.copy2(AUTOMATION / 'contract.js', DIST / 'contract.js')
    shutil.copytree(AUTOMATION / 'dashboard', DIST / 'dashboard')
    # overlay + register → dist/content/
    for name in ['overlay-view.js', 'overlay.js']:
        shutil.copy2(AUTOMATION / 'overlay' / name, DIST / 'content' / name)
    shutil.copy2(AUTOMATION / 'register.js', DIST / 'content' / 'automation-register.js')
    # sourceURL 注入：每个 dist 文件映射回 automation/ 源相对路径（保留子目录，DevTools 调试用）
    _inject_source_url(DIST / 'background' / 'automation-bg-entry.js', 'automation/bg-entry.js')
    _inject_source_url(DIST / 'contract.js', 'automation/contract.js')
    _inject_source_url(DIST / 'background' / 'ws-client.js', 'automation/brain-bridge/ws-client.js')
    _inject_source_url(DIST / 'content' / 'overlay-view.js', 'automation/overlay/overlay-view.js')
    _inject_source_url(DIST / 'content' / 'overlay.js', 'automation/overlay/overlay.js')
    _inject_source_url(DIST / 'content' / 'automation-register.js', 'automation/register.js')
    for js in (DIST / 'background' / 'orchestrator').rglob('*.js'):
        _inject_source_url(js, 'automation/orchestrator/' + str(js.relative_to(DIST / 'background' / 'orchestrator')))
    for js in (DIST / 'dashboard').rglob('*.js'):
        _inject_source_url(js, 'automation/dashboard/' + str(js.relative_to(DIST / 'dashboard')))
    fragment = json.loads((AUTOMATION / 'manifest.fragment.json').read_text(encoding='utf-8'))
    print('[build] automation/ 已装配（dashboard + orchestrator + overlay + register + fragment）')
    # contract.js 作为 content script 注入在 overlay 前：overlay 读 window.__AS_DASH_CONTRACT__.STORAGE_KEY（单一真源）
    return {'pre_core': ['contract.js', 'content/overlay-view.js', 'content/overlay.js'],
            'post_core': ['content/automation-register.js'], 'fragment': fragment}


def assemble_feature_backgrounds(features, with_automation):
    """拷 feature 的 background handler → dist，并在 dist SW 末尾追加 importScripts（feature bg + automation bg-entry）。

    automation-bg-entry 必须排在末尾、在 CPO 段定义之后被 importScripts：bg-entry 顶层 orchRecoverAll() /
    orchNavigateAndWait 调 self.AgentSellerBg.util.waitTabComplete（tab-utils 提供）和 cpoRun/cpoRun2
    （仍在 SW 全局），同 global scope，加载顺序保证已定义。
    """
    # 前提：copy_core_assets 已先拷 service-worker.js 到 dist/background/
    sw = DIST / 'background' / 'service-worker.js'
    lines = []
    for f in features:
        bg = f.get('background')
        if not bg:
            continue
        src = f['_dir'] / bg
        if not src.exists():
            raise FileNotFoundError(f'[build] feature background not found: {src}')
        dst = DIST / 'features' / f['id'] / bg
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        _inject_source_url(dst, str(src.relative_to(ROOT)))
        lines.append(f"importScripts('../features/{f['id']}/{bg}');")
        print(f'[build] feature bg: {src.relative_to(ROOT)} → importScripts')
    if with_automation and AUTOMATION.exists():
        lines.append("importScripts('automation-bg-entry.js');")
    if lines:
        body = sw.read_text(encoding='utf-8').rstrip()
        sw.write_text(body + '\n\n// ── assembled bg (build-injected) ──\n' + '\n'.join(lines) + '\n', encoding='utf-8')


def render_manifest(features=None, automation=None):
    """读模板 → 替换占位符 → 写 dist/extension/manifest.json。
    automation 由 assemble_automation 返回（pre_core/post_core content scripts + fragment）；
    None 时退化为空（release 不装配 automation 的情形）。
    """
    features = features or []
    automation = automation or {'pre_core': [], 'post_core': [], 'fragment': {}}
    template = json.loads((CORE / 'manifest.template.json').read_text(encoding='utf-8'))
    fragment = automation['fragment']

    # storage 留 core（CPO 这个 hub feature 也用 cpo_state，恒需）；windows/CSP 仅 automation fragment 带入，
    # release 不装配 automation → fragment 为空 → 无 windows/无 CSP，manifest 与 main hub 基线一致。
    permissions = sorted({'nativeMessaging', 'storage',
                          *fragment.get('permissions', []),
                          *(p for f in features for p in f.get('permissions', []))})
    host_permissions = sorted({h for f in features for h in f.get('host_permissions', [])})
    content_script_matches = collect_content_matches(features)
    extra_cs = collect_extra_content_scripts(features)

    # core 基础链（不再硬编码 overlay）→ 插 automation pre_core（registry 后 core 前）→ core → post_core → features
    # overlay-view 须排 overlay 前（overlay 引用 window.__AS_OVERLAY_VIEW__）；automation-register 排 core 后
    # （registerExtension 由 registry 提供，core.js 装配 hub 时已就绪）。
    core_js = ['content/build-info.js', 'content/utils.js', 'content/ui.js', 'content/registry.js']
    core_js += automation['pre_core']            # overlay-view, overlay（automation 装配时）
    core_js += ['content/core.js']
    core_js += automation['post_core']           # automation-register（automation 装配时）
    content_scripts_js = core_js + [f'features/{f["id"]}/{f["content_script"]}'
                                    for f in sorted(features, key=lambda x: x.get('order', 999))]

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = content_script_matches
    template['content_scripts'][0]['js'] = content_scripts_js
    for ecs in extra_cs:
        template['content_scripts'].append(ecs)
    if fragment.get('content_security_policy'):
        template['content_security_policy'] = fragment['content_security_policy']

    (DIST / 'manifest.json').write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[build] manifest.json generated  ({len(features)} features, {len(content_scripts_js)} content scripts, automation={"on" if bool(automation["pre_core"]) else "off"})')


def build_all(with_automation: bool = True):
    """全量构建到 dist/extension/。with_automation=True（dev 默认）装配 automation/；
    release（package_all.py 传 False）跳过 automation → 产物纯 hub（无 dashboard/overlay/windows/CSP）。
    """
    clean_dist()
    copy_core_assets()
    emit_build_info()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    automation = assemble_automation(with_automation)
    assemble_feature_backgrounds(features, with_automation)
    render_manifest(features=features, automation=automation)
    print(f'[build] done → {DIST}  (automation={"on" if with_automation else "off"})')


if __name__ == '__main__':
    build_all()
