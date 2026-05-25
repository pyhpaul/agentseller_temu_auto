import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from build_extension import collect_content_matches, collect_extra_content_scripts
from package_all import normalize_manifest_version


def _assert_raises(exc_type, fn, *args):
    try:
        fn(*args)
    except exc_type:
        return
    raise AssertionError(f'expected {exc_type.__name__} for args={args!r}')


def test_content_matches_defaults_to_host_permissions():
    features = [{'host_permissions': ['https://seller.temu.com/*', 'https://*.temu.com/*']}]
    result = collect_content_matches(features)
    assert result == sorted(['https://seller.temu.com/*', 'https://*.temu.com/*'])


def test_content_matches_overrides_with_empty_list():
    # image_search_1688 模式：host_permissions 有 1688，但 content_matches 明确为空
    features = [
        {'host_permissions': ['https://seller.temu.com/*']},
        {'host_permissions': ['https://*.1688.com/*'], 'content_matches': []},
    ]
    result = collect_content_matches(features)
    assert result == ['https://seller.temu.com/*']


def test_content_matches_multiple_features_merged():
    features = [
        {'host_permissions': ['https://seller.temu.com/*']},
        {'host_permissions': ['https://*.temu.com/*']},
    ]
    result = collect_content_matches(features)
    assert 'https://seller.temu.com/*' in result
    assert 'https://*.temu.com/*' in result
    assert result == sorted(result)  # 已排序


def test_extra_content_scripts_resolves_paths():
    features = [{
        'id': 'image_search_1688',
        '_dir': Path('/fake/dir'),
        'extra_content_scripts': [{
            'matches': ['https://s.1688.com/*', 'https://*.1688.com/imgsearch/*'],
            'js': ['content/injector.js'],
            'run_at': 'document_idle',
        }]
    }]
    result = collect_extra_content_scripts(features)
    assert len(result) == 1
    assert result[0]['js'] == ['features/image_search_1688/content/injector.js']
    assert result[0]['matches'] == ['https://s.1688.com/*', 'https://*.1688.com/imgsearch/*']
    assert result[0]['run_at'] == 'document_idle'


def test_extra_content_scripts_empty_when_absent():
    features = [{'id': 'auto_gen_label', '_dir': Path('/fake')}]
    result = collect_extra_content_scripts(features)
    assert result == []


def test_extra_assets_not_in_extra_content_scripts():
    features = [{
        'id': 'img',
        '_dir': Path('/fake'),
        'extra_content_scripts': [],
        'extra_assets': ['content/overlay.css', 'content/overlay.js'],
    }]
    result = collect_extra_content_scripts(features)
    assert result == []


def test_normalize_manifest_version_plain():
    # 正式 tag：已是纯数字段，原样返回
    assert normalize_manifest_version('1.0.1') == '1.0.1'
    assert normalize_manifest_version('1.0.0') == '1.0.0'
    assert normalize_manifest_version('1.2.3.4') == '1.2.3.4'


def test_normalize_manifest_version_strips_rc_suffix():
    # rc tag：Chrome manifest 不支持后缀，截到 - 之前
    assert normalize_manifest_version('1.0.1-rc.1') == '1.0.1'


def test_normalize_manifest_version_strips_git_describe_suffix():
    # git describe 兜底：'1.0.1-3-gabc123' → '1.0.1'
    assert normalize_manifest_version('1.0.1-3-gabc123') == '1.0.1'


def test_normalize_manifest_version_strips_dev_suffix():
    # dev fallback：'0.0.0-dev.abc1234' → '0.0.0'
    assert normalize_manifest_version('0.0.0-dev.abc1234') == '0.0.0'


def test_normalize_manifest_version_rejects_empty():
    _assert_raises(ValueError, normalize_manifest_version, '')


def test_normalize_manifest_version_rejects_non_numeric():
    # 截到 - 之前仍非纯数字段（无合法数字头）应报错
    _assert_raises(ValueError, normalize_manifest_version, 'vendor-1.0')
    _assert_raises(ValueError, normalize_manifest_version, 'dev')


def test_normalize_manifest_version_rejects_too_many_segments():
    # 超过 4 段非法（Chrome manifest 上限 4 段）
    _assert_raises(ValueError, normalize_manifest_version, '1.2.3.4.5')


if __name__ == '__main__':
    test_content_matches_defaults_to_host_permissions()
    test_content_matches_overrides_with_empty_list()
    test_content_matches_multiple_features_merged()
    test_extra_content_scripts_resolves_paths()
    test_extra_content_scripts_empty_when_absent()
    test_normalize_manifest_version_plain()
    test_normalize_manifest_version_strips_rc_suffix()
    test_normalize_manifest_version_strips_git_describe_suffix()
    test_normalize_manifest_version_strips_dev_suffix()
    test_normalize_manifest_version_rejects_empty()
    test_normalize_manifest_version_rejects_non_numeric()
    test_normalize_manifest_version_rejects_too_many_segments()
    print('All tests passed.')
