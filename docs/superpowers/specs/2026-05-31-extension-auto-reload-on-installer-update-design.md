# 扩展自检 + 自动 reload 设计

> 日期：2026-05-31
> 范围：installer / native host / service-worker 三方协作，让员工装新版 installer 后扩展自动应用，无需手动 `chrome://extensions` reload。
> 前置：所有版本（含 v1.1.x）发布机制不变；本次只新增三方协作。
> 关键限制：**v1.1.1 → v1.2.0 这次升级救不了**（v1.1.1 已发出无自检代码），员工仍需手动 reload 一次；**v1.2.1 起对未来所有升级生效**。

## 1. 问题与目标

**问题**：Chrome 不监听 unpacked 扩展的文件变化。installer 把磁盘文件从 v1.x 覆盖成 v1.y，chrome 完全不知道，仍跑内存里加载的旧版 SW + content script。员工必须手动去 `chrome://extensions` 卡片点 reload 或重启 chrome，新版才生效。漏做 → 功能 bug（v1.2.0 复购模式漏 reload 即真实事故）。

**目标**：员工装完新 installer 后扩展自动应用，员工无感、零操作。

**非目标**：
- 不做"等任务空闲再 reload"的精细策略（YAGNI，正常场景员工装包后不会立刻跑批量任务；reload 几秒内完成，状态都在 `chrome.storage.local` 不丢）。
- 不通知员工"正在更新"（已确认走 silent 路径，员工装 installer 即视为同意应用新版）。
- 不解决 v1.1.1 → v1.2.0 这次现网问题（已知硬限制，靠手动 reload 收尾）。

## 2. 工作链路

```
installer (新版 v1.x.y)
 ├─ [Files] 拷新 extension/ 到 {app}\extension\
 ├─ [Code] CurStepChanged ssDone 时写 {app}\installed_version.txt = "{#MyAppVersion}"
 └─ [Run] 注册 native host（现状不变）

chrome 仍跑旧版 SW
 └─ SW 实例化时（顶层代码每次唤醒都跑一次，与 enableSessionStorageAccess 同模式）
     → checkInstalledVersion()
       ├─ connectNative 临时短连接 → 发 {action:'get_installed_version'}
       ├─ 对比 installed（清洗后）vs chrome.runtime.getManifest().version
       └─ installed > loaded → chrome.runtime.reload()
           └─ chrome 从磁盘重读 manifest+所有文件 → 新 SW 启动
               └─ 再次自检 → installed == loaded → 不再 reload（一次性自愈）
```

**关键设计**：三方协作，单一信号源（磁盘上的 marker 文件），SW 自检 + `chrome.runtime.reload()` 自我重载（chrome 唯一允许扩展自我重载的 API）。

## 3. installer 改动

`deploy/installer.iss` 的 `[Code] CurStepChanged` 在 `ssDone` 分支**最顶部**加：

```pascal
SaveStringToFile(ExpandConstant('{app}\installed_version.txt'),
                 '{#MyAppVersion}', False);
```

- 位置：在现有引导对话框逻辑之前（确保对话框弹出时 marker 已写好；员工万一立刻去 chrome reload，自检逻辑也能拿到正确值）。
- 内容：`{#MyAppVersion}` 可能含 rc 后缀（如 `1.3.0-rc.1`）；marker 文件保存原值，SW 端清洗（`split('-')[0]`）后比较，与 `package_all.py` 的 `normalize_manifest_version` 等价处理。
- 失败：`SaveStringToFile` 写失败时 Pascal 默认不报错（False overwrite 参数即覆盖式写入）；写不出 marker 只会让自检 silent fail（business as usual），不阻断安装。
- 卸载：marker 文件在 `{app}\`，跟随 `[Files]` 的卸载机制清理，无需额外 `[UninstallRun]`。

## 4. native host 新 action

`native_host/main.py` 加 `get_installed_version`，读 EXE 同目录的 marker 文件返回 `{success, version}`。**放 `main.py` 顶层**（部署元信息，不算文件操作，不入 `file_ops.py`）：

```python
def _get_installed_version(_msg):
    exe_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
    marker = os.path.join(exe_dir, 'installed_version.txt')
    if not os.path.exists(marker):
        return {'success': False, 'error': 'marker_missing'}
    return {'success': True, 'version': open(marker, encoding='utf-8').read().strip()}
```

在 DISPATCH 表加一行 `'get_installed_version': _get_installed_version,`。

**PyInstaller 路径**：打包后 `sys.argv[0]` 是 EXE 路径（`{app}\TemuLabelHost.exe`），`dirname` 即 `{app}\`，与 installer 写 marker 的目录一致。

**异常处理**：`_msg` 入参不需要（自描述参数名 `_msg` 表明不读）。读失败 Python 异常会被 `main` 的 try/except 捕获返回 `{'success': False, 'error': str(e)}`，SW 端 catch silent。

## 5. service worker 自检

`core/background/service-worker.js` 在 image_search 段顶部（紧邻 `enableSessionStorageAccess`）加 `checkInstalledVersion` 函数 + 顶层调用 + onStartup/onInstalled 监听：

```javascript
async function checkInstalledVersion() {
  let port;
  try {
    port = chrome.runtime.connectNative('com.temu.label_host');
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      port.onMessage.addListener(m => { clearTimeout(t); resolve(m); });
      port.onDisconnect.addListener(() => { clearTimeout(t); reject(new Error('disconnected')); });
      port.postMessage({ action: 'get_installed_version' });
    });
    if (!res?.success || !res.version) return;
    const clean = v => String(v).split('-')[0].trim();
    const installed = clean(res.version);
    const loaded = clean(chrome.runtime.getManifest().version);
    if (cmpVersion(installed, loaded) > 0) {
      console.log(`[auto-reload] 磁盘 v${installed} > 加载 v${loaded}，自动 reload`);
      chrome.runtime.reload();
    }
  } catch { /* native host 未注册 / 旧 EXE / marker 缺失 → silent，不影响业务 */ }
  finally { try { port?.disconnect(); } catch {} }
}
function cmpVersion(a, b) {
  const sa = a.split('.').map(Number), sb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const d = (sa[i] || 0) - (sb[i] || 0); if (d) return d;
  }
  return 0;
}
checkInstalledVersion();   // SW 实例化即跑（顶层模式）
chrome.runtime.onStartup.addListener(checkInstalledVersion);
chrome.runtime.onInstalled.addListener(checkInstalledVersion);
```

**关键设计**：
- **短连接独立于业务 port**：临时 `connectNative` + `disconnect`，不干扰现有 native port 复用机制（业务 feature 各自的 port 不受影响）。
- **3 秒超时**：native host 读 marker 应该极快（几 ms），3s 是兜底，避免 SW 启动卡住。
- **silent fail**：所有异常路径（native host 未注册 / 旧 EXE 不识别 action / marker 缺失 / 超时）都 catch silent，业务不受影响。员工没装新包或没注册 native host 时，扩展正常工作不报错。
- **版本清洗**：`split('-')[0]` 截掉 rc/dev 后缀；`normalize_manifest_version` 在 release 时把 manifest 也清洗了，两边格式一致。
- **顶层 + onStartup + onInstalled 三处触发**：覆盖 SW 各种启动场景（chrome 启动 / 扩展刚装 / 长 idle 后被任意事件唤醒）。

## 6. 边界与防御

| 场景 | 行为 |
|------|------|
| native host 未注册（员工首装前） | `connectNative` 失败 → catch silent |
| EXE 是旧版（不识别 `get_installed_version`） | 返回 `unknown action` 错误 → silent |
| marker 文件缺失（installer 写失败 / 老安装无 marker） | native host 返回 `success:false` → silent |
| 首装 v1.x.y | installer 写 marker `1.x.y`，chrome 加载新 manifest `1.x.y`，相等不 reload |
| rc 包（仅测试用，不发员工） | marker `1.3.0-rc.1` 清洗到 `1.3.0`；manifest 也清洗到 `1.3.0`；相等不 reload。但磁盘文件实际是 rc 版——员工不该装故不发生 |
| reload 打断进行中的 feature 任务 | 极小概率（员工装新包后立刻跑批量任务）。`cpo_state` 等全在 `chrome.storage.local` 不丢；员工重试即可 |
| 无限循环 | reload 后 chrome 从磁盘重读 manifest，installed == loaded，自然停。无循环 |
| 版本号格式异常（marker 被乱写） | `cmpVersion` 用 `Number` 转换，NaN 算 0，比较仍能得出 ≤ 0 → 不 reload。安全降级 |
| installer 失败一半（marker 写了但文件没拷完整） | 概率极低，且 chrome reload 时如果新文件破损，加载报错 → 员工看到 chrome 提示，比 silent bug 更明显 |

## 7. 关键限制

**v1.1.1 → v1.2.0 这次升级救不了** —— v1.1.1 已经发出去、装在员工机器上，没有 `checkInstalledVersion` 代码。员工仍需手动去 `chrome://extensions` 卡片点 reload 一次（或重启 chrome）。

**v1.2.1 起对未来所有升级生效**：v1.2.x 装在员工机器上后，每次升级 chrome 都会自动应用新版本，员工无需任何操作。一次到位、一劳永逸。

## 8. 测试与验证

- **纯逻辑单测**（不依赖 chrome / native host）：`cmpVersion` 拆出来用 `node --test` 测：`cmpVersion('1.3.0','1.2.0')>0` / `cmpVersion('1.2.0','1.2.0')===0` / `cmpVersion('1.2.0','1.3.0')<0` / 段数不等（`'1.2'` vs `'1.2.0'`）。
- **手动验证 1（自动 reload 生效）**：开发机装 v1.2.0 → chrome 加载 → 手改 marker 文件版本号为 `99.0.0`（模拟更新）→ SW 控制台跑 `checkInstalledVersion()` → 观察 chrome 触发 reload + manifest 重读。
- **手动验证 2（首装 silent）**：删除 marker 文件 → SW 启动自检 → native host 返回 `marker_missing` → SW catch silent，业务正常。
- **手动验证 3（native host 旧版兼容）**：装 v1.2.1 扩展 + 旧 v1.2.0 native host EXE（不识别新 action）→ SW 自检收到 unknown action 错误 → silent，业务正常。
