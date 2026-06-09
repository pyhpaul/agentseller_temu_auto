import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from package_all import (
    _strip_dashboard_for_release,
    _strip_windows_permission_for_release,
    _strip_csp_for_release,
)


def _make_extension_dir(tmp_path: Path, with_dashboard: bool) -> Path:
    """在 tmp_path 下建最小 extension 目录结构，可选带 dashboard/。"""
    ext = tmp_path / 'extension'
    # 始终建 background + content，模拟正常产物
    (ext / 'background').mkdir(parents=True)
    (ext / 'background' / 'sw.js').write_text('// sw', encoding='utf-8')
    (ext / 'content').mkdir(parents=True)
    (ext / 'content' / 'ui.js').write_text('// ui', encoding='utf-8')
    if with_dashboard:
        (ext / 'dashboard').mkdir(parents=True)
        (ext / 'dashboard' / 'x.js').write_text('// mock', encoding='utf-8')
        # 嵌套子目录，贴近真实 dashboard（含 mock / state 子目录），验证 rmtree 递归删整棵树
        (ext / 'dashboard' / 'mock').mkdir(parents=True, exist_ok=True)
        (ext / 'dashboard' / 'mock' / 'mock-data.js').write_text('x')
        (ext / 'dashboard' / 'state').mkdir(parents=True, exist_ok=True)
        (ext / 'dashboard' / 'state' / 'store.js').write_text('x')
    return ext


def test_strip_removes_dashboard_keeps_others(tmp_path):
    ext = _make_extension_dir(tmp_path, with_dashboard=True)
    assert (ext / 'dashboard').exists(), 'pre: dashboard 目录应存在'
    assert (ext / 'dashboard' / 'mock' / 'mock-data.js').exists(), 'pre: dashboard 子目录应存在'

    _strip_dashboard_for_release(ext)

    assert not (ext / 'dashboard').exists(), 'dashboard/ 整个目录（含子目录）应已被删除'
    assert (ext / 'background' / 'sw.js').exists(), 'background/ 兄弟目录不应受影响'
    assert (ext / 'content' / 'ui.js').exists(), 'content/ 兄弟目录不应受影响'


def test_strip_idempotent_when_dashboard_absent(tmp_path):
    ext = _make_extension_dir(tmp_path, with_dashboard=False)
    assert not (ext / 'dashboard').exists(), 'pre: dashboard 目录不存在'

    # 不应抛异常
    _strip_dashboard_for_release(ext)

    # 其他目录保持不变
    assert (ext / 'background' / 'sw.js').exists()
    assert (ext / 'content' / 'ui.js').exists()


def test_strip_dashboard_keeps_root_contract(tmp_path):
    """contract.js 提到 dist 根级后，strip dashboard 不应删它（release SW importScripts 依赖）。"""
    ext = _make_extension_dir(tmp_path, with_dashboard=True)
    (ext / 'contract.js').write_text('// shared contract', encoding='utf-8')

    _strip_dashboard_for_release(ext)

    assert not (ext / 'dashboard').exists(), 'dashboard/ 应被删'
    assert (ext / 'contract.js').exists(), '根级 contract.js 不应被删（SW importScripts 依赖）'


def _make_manifest(ext: Path, permissions: list) -> Path:
    """在 ext 目录写最小 manifest.json，permissions 由调用方指定。"""
    ext.mkdir(parents=True, exist_ok=True)
    target = ext / 'manifest.json'
    target.write_text(json.dumps({'permissions': permissions}, ensure_ascii=False, indent=2), encoding='utf-8')
    return target


def test_strip_windows_removes_windows_keeps_others(tmp_path):
    ext = tmp_path / 'extension'
    target = _make_manifest(ext, ['nativeMessaging', 'windows', 'storage'])

    _strip_windows_permission_for_release(ext)

    perms = json.loads(target.read_text(encoding='utf-8'))['permissions']
    assert 'windows' not in perms, 'windows permission 应已被移除'
    assert 'nativeMessaging' in perms, 'nativeMessaging 应保留'
    assert 'storage' in perms, 'storage 应保留'


def test_strip_windows_idempotent_when_absent(tmp_path):
    ext = tmp_path / 'extension'
    target = _make_manifest(ext, ['nativeMessaging', 'storage'])

    # 无 windows 时不应抛异常、不应改动其它 permission
    _strip_windows_permission_for_release(ext)

    perms = json.loads(target.read_text(encoding='utf-8'))['permissions']
    assert perms == ['nativeMessaging', 'storage'], '无 windows 时 permissions 应原样保留'


def test_strip_csp_removes_csp_keeps_others(tmp_path):
    ext = tmp_path / 'extension'
    ext.mkdir(parents=True, exist_ok=True)
    target = ext / 'manifest.json'
    target.write_text(json.dumps({
        'permissions': ['nativeMessaging'],
        'content_security_policy': {'extension_pages': "script-src 'self'; connect-src 'self' ws://localhost:*"},
        'version': '1.0.0',
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    _strip_csp_for_release(ext)

    m = json.loads(target.read_text(encoding='utf-8'))
    assert 'content_security_policy' not in m, 'CSP 应已被移除'
    assert m['permissions'] == ['nativeMessaging'], '其它字段应保留'
    assert m['version'] == '1.0.0', 'version 应保留'


def test_strip_csp_idempotent_when_absent(tmp_path):
    ext = tmp_path / 'extension'
    ext.mkdir(parents=True, exist_ok=True)
    target = ext / 'manifest.json'
    target.write_text(json.dumps({'permissions': ['nativeMessaging']}, ensure_ascii=False, indent=2), encoding='utf-8')

    # 无 CSP 时不应抛异常、不改动其它字段
    _strip_csp_for_release(ext)

    m = json.loads(target.read_text(encoding='utf-8'))
    assert m == {'permissions': ['nativeMessaging']}, '无 CSP 时 manifest 应原样保留'


if __name__ == '__main__':
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        test_strip_removes_dashboard_keeps_others(Path(d) / 'case1')
    with tempfile.TemporaryDirectory() as d:
        test_strip_idempotent_when_dashboard_absent(Path(d) / 'case2')
    with tempfile.TemporaryDirectory() as d:
        test_strip_dashboard_keeps_root_contract(Path(d) / 'case3')
    with tempfile.TemporaryDirectory() as d:
        test_strip_windows_removes_windows_keeps_others(Path(d) / 'case4')
    with tempfile.TemporaryDirectory() as d:
        test_strip_windows_idempotent_when_absent(Path(d) / 'case5')
    with tempfile.TemporaryDirectory() as d:
        test_strip_csp_removes_csp_keeps_others(Path(d) / 'case6')
    with tempfile.TemporaryDirectory() as d:
        test_strip_csp_idempotent_when_absent(Path(d) / 'case7')
    print('All tests passed.')
