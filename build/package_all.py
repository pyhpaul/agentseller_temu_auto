"""
package_all.py — 出员工部署包：
1) 跑 build_extension 出 dist/extension/
2) 调 features/auto_gen_label/build/build.bat 出 TemuLabelHost.exe（Windows 平台）
3) 拼装 dist/TemuLabel_Setup/{extension, TemuLabelHost.exe, install.bat, com.temu.label_host.json}
4) 调 Inno Setup 把 dist/TemuLabel_Setup/ 打成单文件 dist/TemuLabelSetup.exe（Windows + Inno Setup 已装）

注：发布版会把 TAL_DEBUG=true 关掉。源码位于 features/auto_gen_label/content/index.js，
构建产物落到 dist/extension/features/auto_gen_label/content/index.js，
本脚本统一在拷贝到 setup 目录后用 Python 替换并显式校验（修复原 errorlevel 假阴性问题）。

Inno Setup 是可选步骤：找不到 ISCC.exe（非 Windows、或 Windows 上未装）会打印警告
并跳过，不影响前面四步的产物（TemuLabel_Setup/ 仍可用于手动部署）。
"""
import os
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
    build_all()

    print('[package] 2/5 构建 native_host EXE...')
    build_bat = ROOT / 'features' / 'auto_gen_label' / 'build' / 'build.bat'
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
    # 关掉 release 版的 TAL_DEBUG
    _replace_tal_debug_to_false(SETUP_DIR / 'extension')

    # native_host EXE（features/auto_gen_label/build/build.bat 的 --distpath native_host 决定落点）
    exe_src = ROOT / 'features' / 'auto_gen_label' / 'native_host' / 'TemuLabelHost.exe'
    if exe_src.exists():
        shutil.copy2(exe_src, SETUP_DIR / 'TemuLabelHost.exe')
        print(f'[package] EXE 已拷贝')
    else:
        print(f'[package] 警告：未找到 {exe_src.relative_to(ROOT)}，部署包不完整（Linux 上预期；Windows 上需先跑 build.bat）')

    # install.bat + com.temu.label_host.json
    install_bat = ROOT / 'features' / 'auto_gen_label' / 'native_host' / 'install.bat'
    if install_bat.exists():
        shutil.copy2(install_bat, SETUP_DIR / 'install.bat')
    host_json = ROOT / 'features' / 'auto_gen_label' / 'native_host' / 'com.temu.label_host.json'
    if host_json.exists():
        shutil.copy2(host_json, SETUP_DIR / 'com.temu.label_host.json')

    print(f'[package] 4/5 部署目录就绪 → {SETUP_DIR}')
    print('[package] 内容：')
    for entry in sorted(SETUP_DIR.iterdir()):
        print(f'  - {entry.name}')

    build_installer()


if __name__ == '__main__':
    main()
