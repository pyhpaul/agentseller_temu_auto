import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from build_extension import collect_content_matches, collect_extra_content_scripts


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


if __name__ == '__main__':
    test_content_matches_defaults_to_host_permissions()
    test_content_matches_overrides_with_empty_list()
    test_content_matches_multiple_features_merged()
    test_extra_content_scripts_resolves_paths()
    test_extra_content_scripts_empty_when_absent()
    print('All tests passed.')
