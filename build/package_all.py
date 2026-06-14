"""
package_all.py — 出员工部署包：
1) 跑 build_extension 出 dist/extension/
2) 调 native_host/build/build.bat 出 TemuLabelHost.exe（Windows 平台）
3) 拼装 dist/TemuLabel_Setup/{extension, TemuLabelHost.exe, install.bat, com.temu.label_host.json}
4) 调 Inno Setup 把 dist/TemuLabel_Setup/ 打成单文件 dist/TemuLabelSetup.exe（Windows + Inno Setup 已装）

注：发布版会把 TAL_DEBUG=true 关掉。源码位于 features/auto_gen_label/content/index.js，
构建产物落到 dist/extension/features/auto_gen_label/content/index.js，
本脚本统一在拷贝到 setup 目录后用 Python 替换并显式校验（修复原 errorlevel 假阴性问题）。

Inno Setup 是可选步骤：找不到 ISCC.exe（非 Windows、或 Windows 上未装）会打印警告
并跳过，不影响前面四步的产物（TemuLabel_Setup/ 仍可用于手动部署）。
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_extension import ROOT, DIST, build_all

SETUP_DIR = ROOT / 'dist' / 'TemuLabel_Setup'

# Inno Setup 编译器候选路径（Windows 上默认安装位置）
ISCC_CANDIDATES = [
    r'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    r'C:\Program Files\Inno Setup 6\ISCC.exe',
]
ISS = ROOT / 'deploy' / 'installer.iss'


def _replace_tal_debug_to_false(extension_root: Path):
    """把 release 部署包内 feature 的 TAL_DEBUG 常量从 true 改为 false。

    显式校验：替换前必须命中 'const TAL_DEBUG = true;'，命中数为 0 则报错退出
    （修复原 package.bat 用 powershell -replace 时 errorlevel 在 0 命中也返回 0 的假阴性）。
    """
    target = extension_root / 'features' / 'auto_gen_label' / 'content' / 'index.js'
    if not target.exists():
        print(f'[package] 警告：未找到 {target}，跳过 TAL_DEBUG 替换')
        return
    src = target.read_text(encoding='utf-8')
    needle = 'const TAL_DEBUG = true;'
    if needle not in src:
        print(f'[package] 错误：{target} 中未找到 "{needle}"', file=sys.stderr)
        sys.exit(2)
    dst = src.replace(needle, 'const TAL_DEBUG = false;', 1)
    if dst == src:
        print('[package] 错误：TAL_DEBUG 替换未生效', file=sys.stderr)
        sys.exit(2)
    target.write_text(dst, encoding='utf-8')
    print(f'[package] TAL_DEBUG = false 已写入 {target.relative_to(ROOT)}')


_ISS_VERSION_RE = re.compile(r'#define\s+MyAppVersion\s+"([^"]+)"')


def _read_installer_version() -> str:
    """从 deploy/installer.iss 读 #define MyAppVersion 值。

    CI 流程下 inject_version.py 已经把这个值改成 tag 解析结果；本地直跑时是默认 '1.0.0'
    或上次跑 inject_version 留下的 dev 版本号。
    """
    iss = ROOT / 'deploy' / 'installer.iss'
    if not iss.exists():
        return ''
    m = _ISS_VERSION_RE.search(iss.read_text(encoding='utf-8'))
    return m.group(1) if m else ''


_MANIFEST_VERSION_RE = re.compile(r'^\d+(\.\d+){0,3}$')


def normalize_manifest_version(raw: str) -> str:
    """把 installer.iss 的 MyAppVersion 清洗成 Chrome manifest 合法的纯数字段版本号。

    Chrome manifest `version` 只接受 1-4 段点分整数，禁止后缀；带后缀会导致扩展加载失败。
    MyAppVersion 可能形如 '1.0.1' / '1.0.1-rc.1' / '1.0.1-3-gabc123' / '0.0.0-dev.sha'，
    统一截取首个 '-' 之前的部分，再校验是否为合法数字段。

    rc 版本（'1.0.1-rc.1'）清洗后与正式版（'1.0.1'）的 manifest version 相同，
    这是 Chrome 硬限制；rc 包不发员工，panel 标题栏仍显示完整 'v1.0.1-rc.1'。
    """
    base = raw.split('-', 1)[0]
    if not _MANIFEST_VERSION_RE.match(base):
        raise ValueError(
            f'无法从「{raw}」得到 Chrome manifest 合法版本号'
            f'（截取得到「{base}」，要求 1-4 段点分整数）'
        )
    return base


def _set_manifest_version_for_release(extension_root: Path):
    """release 部署包把 manifest.json 的 version 从模板默认 '1.0.0' 改成真实 tag 版本号。

    与 build-info 的 version 注入对称：dev 阶段 manifest 保持模板默认（chrome://extensions
    显示 1.0.0，无版本号语义），release 阶段从 installer.iss 读 tag 版本写入，
    让扩展卡片与 panel 标题栏版本号一致。

    失败保护：读不到 installer 版本号、或清洗后非法都直接退出，防止 release 包发出错版本。
    """
    target = extension_root / 'manifest.json'
    if not target.exists():
        print(f'[package] 错误：未找到 {target}', file=sys.stderr)
        sys.exit(2)
    version = _read_installer_version()
    if not version:
        print('[package] 错误：无法从 installer.iss 读取 MyAppVersion', file=sys.stderr)
        sys.exit(2)
    try:
        manifest_version = normalize_manifest_version(version)
    except ValueError as e:
        print(f'[package] 错误：{e}', file=sys.stderr)
        sys.exit(2)
    manifest = json.loads(target.read_text(encoding='utf-8'))
    old = manifest.get('version')
    manifest['version'] = manifest_version
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[package] manifest.json version: {old} → {manifest_version} → {target.relative_to(ROOT)}')


def _strip_dashboard_for_release(extension_root: Path):
    """release 部署包剥离 dashboard 监控页（开发中的自动化监控系统扩展页，半成品不随员工包发布）。

    dashboard（core/dashboard/）是独立扩展页，build_extension.py 的 copy_dashboard_assets
    无条件拷进 dist 供 dev 本地验证；但员工发版包不含半成品。故在此从部署副本删除整个
    dashboard/ 目录（不碰 dev 的 dist/extension/）。Hub「打开监控」入口另在 ui.js 用 isDev 守卫。

    幂等：dashboard 目录不存在时静默跳过（如未来彻底移除或本次构建未含 dashboard）。
    CSP（manifest content_security_policy）由 _strip_csp_for_release 单独剥离（dashboard 依赖项，
    release manifest 与 main 基线零差异）。
    """
    dash = extension_root / 'dashboard'
    if dash.exists():
        try:
            shutil.rmtree(dash)
        except OSError as e:
            print(f'[package] 错误：dashboard/ 剥离失败（{e}），release 包中止', file=sys.stderr)
            sys.exit(2)
        print('[package] dashboard/ 已从 release 部署包剥离（dev-only，半成品不随员工包发布）')
    else:
        print('[package] dashboard/ 不在部署包（未构建或已剥离），跳过')


def _strip_windows_permission_for_release(extension_root: Path):
    """release 部署包从 manifest 移除 windows permission（dashboard 监控入口 dev-only，release 剥离）。
    OPEN_MONITOR（chrome.windows 打开 dashboard）是 dev-only：Hub 按钮 isDev 守卫 + dashboard 目录已剥离，
    release 不触发它（即便触发也 tabs.create 兜底），故移除其依赖的 windows permission，
    避免员工安装时出现多余「管理窗口」权限提示。manifest 无 windows 时静默跳过（幂等）。
    """
    target = extension_root / 'manifest.json'
    if not target.exists():
        print(f'[package] 警告：未找到 {target}，跳过 windows permission 剥离')
        return
    manifest = json.loads(target.read_text(encoding='utf-8'))
    perms = manifest.get('permissions', [])
    if 'windows' in perms:
        manifest['permissions'] = [p for p in perms if p != 'windows']
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        print('[package] windows permission 已从 release manifest 移除（dashboard 监控 dev-only）')
    else:
        print('[package] release manifest 无 windows permission，跳过')


def _strip_csp_for_release(extension_root: Path):
    """release 部署包从 manifest 移除 content_security_policy（dashboard 监控依赖，dev-only）。

    CSP extension_pages（放行 ws://localhost）是 dashboard 监控页 + Plan 3 WS 的依赖，dev-only。
    release 剥离 dashboard 后该字段无用，移除让 release manifest 与 main 基线零差异
    （彻底响应「不影响发版内容」）。Plan 3 dashboard 转正纳入发版时再让 CSP 进 release。
    manifest 无 content_security_policy 时静默跳过（幂等）。
    """
    target = extension_root / 'manifest.json'
    if not target.exists():
        print(f'[package] 警告：未找到 {target}，跳过 CSP 剥离')
        return
    manifest = json.loads(target.read_text(encoding='utf-8'))
    if 'content_security_policy' in manifest:
        del manifest['content_security_policy']
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        print('[package] content_security_policy 已从 release manifest 移除（dashboard 监控 dev-only）')
    else:
        print('[package] release manifest 无 content_security_policy，跳过')


def _disable_build_info_for_release(extension_root: Path):
    """release 部署包关闭 dev 构建时间戳显示 + 注入真实版本号到 build-info.js。

    - isDev: true → false（隐藏 dev:<ts> 显示）
    - version: 'dev' → 'X.Y.Z'（panel 标题栏改显 v<version>，员工自助查版本号）

    失败保护：两个 needle 未命中都直接退出，防止 release 包混入 dev 标识。
    """
    target = extension_root / 'content' / 'build-info.js'
    if not target.exists():
        print(f'[package] 警告：未找到 {target}，跳过 build-info 替换')
        return
    src = target.read_text(encoding='utf-8')
    for needle in ('isDev: true', "version: 'dev'"):
        if needle not in src:
            print(f'[package] 错误：{target} 中未找到 "{needle}"', file=sys.stderr)
            sys.exit(2)
    version = _read_installer_version()
    if not version:
        print(f'[package] 错误：无法从 installer.iss 读取 MyAppVersion', file=sys.stderr)
        sys.exit(2)
    dst = src.replace('isDev: true', 'isDev: false', 1)
    dst = dst.replace("version: 'dev'", f"version: '{version}'", 1)
    target.write_text(dst, encoding='utf-8')
    print(f'[package] build-info release 化：isDev=false, version={version} → {target.relative_to(ROOT)}')


def build_installer():
    """用 Inno Setup 把 dist/TemuLabel_Setup/ 打成 dist/TemuLabelSetup.exe。

    找不到 ISCC.exe 时只警告不报错——Linux 上跑 package_all.py 不应被这步阻断。
    """
    iscc = next((p for p in ISCC_CANDIDATES if Path(p).exists()), None)
    if not iscc:
        print('[package] 5/5 警告：未找到 Inno Setup（ISCC.exe），跳过 setup.exe 生成')
        print('         下载安装：https://jrsoftware.org/isdl.php')
        print(f'         手动部署仍可用：{SETUP_DIR.relative_to(ROOT)}/')
        return
    if not ISS.exists():
        print(f'[package] 错误：{ISS.relative_to(ROOT)} 不存在', file=sys.stderr)
        sys.exit(2)
    print('[package] 5/5 用 Inno Setup 打包 setup.exe...')
    subprocess.check_call([iscc, str(ISS)])
    setup_exe = ROOT / 'dist' / 'TemuLabelSetup.exe'
    if setup_exe.exists():
        size_mb = setup_exe.stat().st_size // (1024 * 1024)
        print(f'[package] setup.exe 已生成：{setup_exe.relative_to(ROOT)}（约 {size_mb} MB）')
    else:
        print('[package] 警告：ISCC 调用完成但未发现 dist/TemuLabelSetup.exe，请检查 installer.iss')


def main():
    print('[package] 1/5 构建 extension dist...')
    # release 不装配 automation/（with_automation=False）→ 产物纯 hub：无 dashboard/overlay/
    # orchestrator/automation-bg-entry/automation-register（📊 监控按钮）/windows/CSP。下方 3 个
    # strip 函数（dashboard/windows/CSP）因 automation 未装配而成幂等 no-op，保留作双保险，
    # 移除留文档同步 task。理由见 plan Task 1.7 Step 5。
    build_all(with_automation=False)

    print('[package] 2/5 构建 native_host EXE...')
    build_bat = ROOT / 'native_host' / 'build' / 'build.bat'
    if not build_bat.exists():
        print(f'[package] 错误：{build_bat} 不存在', file=sys.stderr)
        sys.exit(1)
    if sys.platform == 'win32':
        # PACKAGE_ALL=1 让 build.bat 跳过末尾交互式 pause，避免 subprocess 死锁
        env = {**os.environ, 'PACKAGE_ALL': '1'}
        subprocess.check_call(['cmd', '/c', str(build_bat)], cwd=str(build_bat.parent), env=env)
    else:
        print('[package] 非 Windows 平台，跳过 EXE 构建（仅在 Windows 上能出可用部署包）')

    print('[package] 3/5 拼装部署目录...')
    if SETUP_DIR.exists():
        shutil.rmtree(SETUP_DIR)
    SETUP_DIR.mkdir(parents=True)

    # extension 目录（dist 产物）
    shutil.copytree(DIST, SETUP_DIR / 'extension')
    # 关掉 release 版的 TAL_DEBUG + dev build 时间戳显示，并把 manifest 版本号同步成 tag
    _replace_tal_debug_to_false(SETUP_DIR / 'extension')
    _disable_build_info_for_release(SETUP_DIR / 'extension')
    _strip_dashboard_for_release(SETUP_DIR / 'extension')      # 新增：剥离半成品 dashboard
    _strip_windows_permission_for_release(SETUP_DIR / 'extension')  # 剥离 dashboard 依赖的 windows permission
    _strip_csp_for_release(SETUP_DIR / 'extension')                 # 剥离 dashboard 依赖的 CSP（release manifest 与 main 零差异）
    _set_manifest_version_for_release(SETUP_DIR / 'extension')

    # native_host EXE（native_host/build/build.bat 的 --distpath . 决定落点：native_host/）
    exe_src = ROOT / 'native_host' / 'TemuLabelHost.exe'
    if exe_src.exists():
        shutil.copy2(exe_src, SETUP_DIR / 'TemuLabelHost.exe')
        print(f'[package] EXE 已拷贝')
    else:
        print(f'[package] 警告：未找到 {exe_src.relative_to(ROOT)}，部署包不完整（Linux 上预期；Windows 上需先跑 build.bat）')

    # install.bat + com.temu.label_host.json
    install_bat = ROOT / 'native_host' / 'install.bat'
    if install_bat.exists():
        shutil.copy2(install_bat, SETUP_DIR / 'install.bat')
    host_json = ROOT / 'native_host' / 'com.temu.label_host.json'
    if host_json.exists():
        shutil.copy2(host_json, SETUP_DIR / 'com.temu.label_host.json')

    print(f'[package] 4/5 部署目录就绪 → {SETUP_DIR}')
    print('[package] 内容：')
    for entry in sorted(SETUP_DIR.iterdir()):
        print(f'  - {entry.name}')

    build_installer()


if __name__ == '__main__':
    main()
