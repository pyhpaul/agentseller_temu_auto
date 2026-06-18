# native_host/config.py — LLM/图像 API key 配置源（员工 release 可用）。
#
# 配置源接口：现在实现本地 DPAPI（员工在 Chrome 设置面板填 key，DPAPI 加密落盘）；
# 将来放开使用时加 ProxyConfig（向公司代理取 token）不动调用方——provider 代码只认接口。
#
# 安全：
# - Windows DPAPI（CryptProtectData）加密落盘，绑当前 Windows 用户——防外部偷、防同机
#   其他用户/非登录态恶意程序；不防员工本人（他自己登进来能解密，本地存放天花板，够用）。
# - get_llm_config 给 handler 用、返回明文 key（进程内）；get_llm_config_status 给 Chrome
#   端展示用、只回 {configured, model} 绝不回 key 明文——key 永不离开 native host 进程。
# - 非 Windows（开发期 WSL）退化明文存，仅用于本地测试；release 是 PyInstaller EXE 只在
#   Windows 跑。
import os
import json
import base64
import logging

log = logging.getLogger(__name__)

# 配置文件位置：优先 EXE 同目录（release installer 装的 {app}\），退化 %APPDATA%（开发期）。
# EXE 同目录与 installed_version.txt marker 同处，installer 卸载时一并清理。
def _config_path():
    exe_dir = os.path.dirname(os.path.abspath(_get_argv0()))
    candidate = os.path.join(exe_dir, 'llm_config.json')
    try:
        # 测试可写就用它（release EXE 目录可写）
        if os.access(exe_dir, os.W_OK) or os.path.exists(candidate):
            return candidate
    except Exception:
        pass
    # 退化用户目录（开发期 EXE 目录可能只读）
    appdata = os.environ.get('APPDATA')
    if appdata:
        return os.path.join(appdata, 'TemuLabelHost', 'llm_config.json')
    return candidate  # 非 Windows 也落 EXE 同目录


def _get_argv0():
    # 测试时 monkeypatch 用；release 是 sys.argv[0] = EXE 路径
    import sys
    return sys.argv[0] if sys.argv else __file__


# ---- Windows DPAPI（ctypes，免 pywin32 依赖）----

def _dpapi_available():
    try:
        import ctypes
        return hasattr(ctypes.windll, 'crypt32')  # 仅 Windows 有 windll
    except Exception:
        return False


def _dpapi_protect(plain_bytes):
    """CryptProtectData 加密。返回加密 bytes。失败抛异常。"""
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD),
                    ('pbData', ctypes.POINTER(ctypes.c_char))]

    in_blob = DATA_BLOB(len(plain_bytes), ctypes.cast(
        ctypes.create_string_buffer(plain_bytes, len(plain_bytes)),
        ctypes.POINTER(ctypes.c_char)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        raise OSError('CryptProtectData 失败')
    try:
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
    return encrypted


def _dpapi_unprotect(encrypted_bytes):
    """CryptUnprotectData 解密。返回明文 bytes。失败抛异常。"""
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD),
                    ('pbData', ctypes.POINTER(ctypes.c_char))]

    in_blob = DATA_BLOB(len(encrypted_bytes), ctypes.cast(
        ctypes.create_string_buffer(encrypted_bytes, len(encrypted_bytes)),
        ctypes.POINTER(ctypes.c_char)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        raise OSError('CryptUnprotectData 失败（可能换用户/换机器，DPAPI 绑原用户）')
    try:
        plain = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
    return plain


def _encrypt(plain_str):
    """加密字符串 → base64 存 JSON。Windows 用 DPAPI，非 Windows 明文（开发期）。"""
    raw = plain_str.encode('utf-8')
    if _dpapi_available():
        enc = _dpapi_protect(raw)
        return {'encrypted': True, 'data': base64.b64encode(enc).decode('ascii')}
    log.warning('非 Windows 环境，LLM key 明文存储（仅开发期，release 只在 Windows 跑）')
    return {'encrypted': False, 'data': base64.b64encode(raw).decode('ascii')}


def _decrypt(blob):
    """解密 _encrypt 的产物 → 明文字符串。"""
    if not isinstance(blob, dict):
        raise ValueError('配置项格式错误')
    raw = base64.b64decode(blob['data'])
    if blob.get('encrypted'):
        if not _dpapi_available():
            raise OSError('加密配置在非 Windows 环境无法解密')
        plain = _dpapi_unprotect(raw)
    else:
        plain = raw
    return plain.decode('utf-8')


# ---- 配置存读 ----

def _load_all():
    """读整个配置 JSON。无文件返回 {}。"""
    path = _config_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception as e:
        log.warning('读取 LLM 配置失败：%s', e)
        return {}


def _save_all(cfg):
    """写整个配置 JSON。"""
    path = _config_path()
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def set_llm_config(base_url, api_key, model):
    """保存 LLM 配置（员工在 Chrome 设置面板填时调）。key 经 DPAPI 加密落盘。"""
    base_url = (base_url or '').strip()
    api_key = (api_key or '').strip()
    model = (model or '').strip()
    if not base_url or not api_key:
        return {'success': False, 'error': 'base_url 和 api_key 不能为空'}
    cfg = _load_all()
    cfg['llm'] = {
        'base_url': base_url,
        'api_key': _encrypt(api_key),
        'model': model or 'glm-4-plus',
    }
    try:
        _save_all(cfg)
    except Exception as e:
        return {'success': False, 'error': '保存配置失败：%s' % e}
    log.info('LLM 配置已保存（model=%s）', cfg['llm']['model'])
    return {'success': True}


def get_llm_config():
    """给 handler 用：返回 {base_url, api_key, model} 明文，未配置返回 None。
    key 在 native host 进程内使用，不回传 Chrome。"""
    # 优先本地 DPAPI 配置文件；退化读环境变量（开发期 .env.local / 兼容旧方式）
    cfg = _load_all()
    llm = cfg.get('llm') if isinstance(cfg, dict) else None
    if isinstance(llm, dict) and llm.get('api_key'):
        try:
            return {
                'base_url': llm.get('base_url', ''),
                'api_key': _decrypt(llm['api_key']),
                'model': llm.get('model', 'glm-4-plus'),
            }
        except Exception as e:
            log.warning('解密 LLM key 失败，退化读环境变量：%s', e)
    # 退化环境变量（开发期）
    base = os.environ.get('LLM_BASE_URL', '').strip()
    key = os.environ.get('LLM_API_KEY', '').strip()
    if base and key:
        return {'base_url': base, 'api_key': key,
                'model': (os.environ.get('LLM_MODEL', '') or 'glm-4-plus').strip()}
    return None


def get_llm_config_status():
    """给 Chrome 端展示用：只回 {configured, model}，绝不回 key 明文。"""
    c = get_llm_config()
    if not c:
        return {'success': True, 'configured': False}
    return {'success': True, 'configured': True, 'model': c.get('model', '')}


def clear_llm_config():
    """清除 LLM 配置（员工清 key / 离职换人时调）。"""
    cfg = _load_all()
    if 'llm' in cfg:
        del cfg['llm']
        try:
            _save_all(cfg)
        except Exception as e:
            return {'success': False, 'error': '清除配置失败：%s' % e}
    return {'success': True}
