"""
inject_version.py — 把版本号注入 deploy/installer.iss 的 #define MyAppVersion。

版本号来源（优先级从高到低）：
1. CI tag 触发：环境变量 GITHUB_REF_NAME（如 'v1.0.1' → '1.0.1'）
2. git describe --tags --always（如 'v1.0.1-3-gabc123' → '1.0.1-3-gabc123'）
3. 兜底：'0.0.0-dev.<short_sha>'
4. 完全拿不到 git 信息：保留 installer.iss 现有值（仅本地，不阻断）

CI 严格模式：环境变量 CI=true 时，第 3/4 兜底必须显式允许（CI_ALLOW_DEV=1），
否则报错退出——防止 tag workflow 误打出无版本号的 release 包。

Inno Setup MyAppVersion 注意：
- 数字段（X.Y.Z 或 X.Y.Z.W）才能被 Inno 用于自动升级识别
- 带后缀（-rc.1 / -dev.sha）退化为字符串比较，员工机器升级时需手动卸载重装
- 详见 生产环境使用指导.md A.7 tag 规则
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ISS = ROOT / 'deploy' / 'installer.iss'
VERSION_RE = re.compile(r'^(#define\s+MyAppVersion\s+")([^"]+)(")\s*$', re.MULTILINE)


def _strip_v(tag: str) -> str:
    """'v1.0.1' → '1.0.1'，'1.0.1' → '1.0.1'。"""
    return tag[1:] if tag.startswith('v') else tag


def _from_github_ref() -> str | None:
    """CI tag 触发时 GITHUB_REF_NAME 是 'v1.0.1'。非 tag 触发返回 None。"""
    if os.environ.get('GITHUB_REF', '').startswith('refs/tags/'):
        return _strip_v(os.environ['GITHUB_REF_NAME'])
    return None


def _from_git_describe() -> str | None:
    """`git describe --tags --always` 兜底。返回 None 表示完全没 git 信息。"""
    try:
        out = subprocess.check_output(
            ['git', 'describe', '--tags', '--always'],
            cwd=ROOT, stderr=subprocess.DEVNULL, text=True
        ).strip()
        return _strip_v(out) if out else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _dev_fallback() -> str | None:
    """无 tag 时用 '0.0.0-dev.<short_sha>'。完全无 git 返回 None。"""
    try:
        sha = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=ROOT, stderr=subprocess.DEVNULL, text=True
        ).strip()
        return f'0.0.0-dev.{sha}' if sha else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def resolve_version() -> tuple[str, str]:
    """返回 (version, source)。source 用于日志说明版本号从哪来。"""
    v = _from_github_ref()
    if v:
        return v, 'GITHUB_REF (tag)'

    v = _from_git_describe()
    # git describe 在打过 tag 的仓库返回带版本的字符串，否则返回 7 位 sha
    # 如果是裸 sha（无版本号前缀），降级到 dev_fallback 拼前缀
    if v and re.match(r'^\d+\.\d+', v):
        return v, 'git describe'

    v = _dev_fallback()
    if v:
        return v, 'dev fallback (no tag)'

    return '', 'unavailable'


def inject(version: str) -> None:
    """把 installer.iss 里 #define MyAppVersion 替换成新值。"""
    if not ISS.exists():
        print(f'[inject_version] 错误：{ISS.relative_to(ROOT)} 不存在', file=sys.stderr)
        sys.exit(2)
    src = ISS.read_text(encoding='utf-8')
    m = VERSION_RE.search(src)
    if not m:
        print(f'[inject_version] 错误：在 {ISS.name} 找不到 #define MyAppVersion 行', file=sys.stderr)
        sys.exit(2)
    old = m.group(2)
    if old == version:
        print(f'[inject_version] 版本号已是 {version}，无需替换')
        return
    new = VERSION_RE.sub(rf'\g<1>{version}\g<3>', src, count=1)
    ISS.write_text(new, encoding='utf-8')
    print(f'[inject_version] MyAppVersion: {old} → {version}')


def main() -> None:
    version, source = resolve_version()
    is_ci = os.environ.get('CI', '').lower() == 'true'

    if not version:
        msg = '[inject_version] 无法解析版本号（无 git / 无 tag / 无 HEAD）'
        if is_ci and os.environ.get('CI_ALLOW_DEV') != '1':
            print(msg + '，CI 环境硬退出', file=sys.stderr)
            sys.exit(2)
        print(msg + '，本地保留 installer.iss 现值')
        return

    if 'dev' in source and is_ci and os.environ.get('CI_ALLOW_DEV') != '1':
        print(
            f'[inject_version] 错误：CI 环境拒绝 dev 版本号「{version}」'
            '（设 CI_ALLOW_DEV=1 显式允许）',
            file=sys.stderr,
        )
        sys.exit(2)

    print(f'[inject_version] 解析到版本：{version}（来源：{source}）')
    inject(version)


if __name__ == '__main__':
    main()
