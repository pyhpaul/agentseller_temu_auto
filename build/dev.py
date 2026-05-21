"""
dev.py — watch 模式：监听源目录，增量同步到 dist/extension/。
启动时先全量构建一次，之后只同步变化的文件。
"""
import sys
import time
import shutil
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_extension import (
    ROOT, CORE, DIST, build_all, scan_features, render_manifest, _inject_source_url
)


def _src_to_dst(src_path: Path):
    """把源路径映射到 dist 路径。返回 None 表示忽略。"""
    try:
        rel = src_path.relative_to(ROOT)
    except ValueError:
        return None
    parts = rel.parts
    if not parts:
        return None
    # core/sub/... → dist/extension/sub/...（不直接映射 manifest.template.json，那个走重生 manifest 分支）
    if parts[0] == 'core' and len(parts) >= 3 and parts[1] != 'manifest.template.json':
        return DIST / Path(*parts[1:])
    # features/<feature>/content/... → dist/extension/features/<feature>/content/...
    if len(parts) >= 4 and parts[0] == 'features' and parts[2] == 'content':
        feature_id = parts[1]
        return DIST / 'features' / feature_id / Path(*parts[2:])
    return None


def _on_change(src_path: Path):
    try:
        rel = src_path.relative_to(ROOT)
    except ValueError:
        return
    # feature.json / manifest.template.json 变化：重生 manifest
    if src_path.name == 'feature.json' or src_path.name == 'manifest.template.json':
        features = scan_features()
        render_manifest(features=features)
        print(f'[manifest] 检测到 {rel} 变化，重生 manifest.json')
        return
    dst = _src_to_dst(src_path)
    if not dst:
        return
    if src_path.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, dst)
        if dst.suffix == '.js':
            _inject_source_url(dst, str(rel))
        print(f'[sync] {rel} → {dst.relative_to(ROOT)}')
    else:
        if dst.exists():
            dst.unlink()
            print(f'[sync] 删除 {dst.relative_to(ROOT)}')


class Handler(FileSystemEventHandler):
    def on_modified(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))

    def on_created(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))

    def on_deleted(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))


def main():
    print('[dev] 启动初始构建...')
    build_all()
    print('[watch] monitoring: core/, features/*/content/, features/*/feature.json')
    print(f'[watch] chrome 请加载 {DIST}，修改源码会自动同步')

    obs = Observer()
    handler = Handler()
    obs.schedule(handler, str(CORE), recursive=True)
    for f in scan_features():
        obs.schedule(handler, str(f['_dir']), recursive=True)
    obs.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        obs.stop()
    obs.join()


if __name__ == '__main__':
    main()
