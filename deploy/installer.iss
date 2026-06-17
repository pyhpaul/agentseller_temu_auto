; ==============================================================================
; Temu Label Helper - Inno Setup 一键安装脚本
; ==============================================================================
;
; 用途：把 dist\TemuLabel_Setup\ 目录打包成单文件 TemuLabelSetup.exe，
;       员工双击 → Next/Next/Finish 即可完成 native host 注册。
;
; 设计取舍：
;   - **不直接调 native_host/install.bat**：
;     原 install.bat 末尾有 `pause`，Inno Setup 用 runhidden 调用会卡死
;     (无法响应按键)。本脚本在 [Run]/[Code] 段用 PowerShell + reg.exe
;     原生命令完成等价工作，行为与 install.bat 完全一致。
;   - 安装路径用 {localappdata}\TemuLabel（不需要管理员权限），
;     原 install.bat 用 %APPDATA%\TemuLabel\，两者对 Native Host 无差异
;     —— 注册表 key 指向 manifest 绝对路径即可。
;   - manifest 内 PLACEHOLDER 由 PowerShell 替换为实际 EXE 路径和默认
;     Extension ID（与 install.bat 内置默认一致）。
;
; 编译：
;   Windows 上装 Inno Setup 6.x 后，ISCC.exe deploy\installer.iss
;   build/package_all.py 末尾会自动调它。
; ==============================================================================

#define MyAppName "Temu Label Helper"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "AgentSeller"
#define MyHostName "com.temu.label_host"
#define MyDefaultExtId "dnamfbakkceljnlhiekgjbjchgooaljm"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\TemuLabel
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; DisableDirPage 留默认（向导显示「选择安装位置」页），员工可改装到 D:\ 等
; 其他用户可写目录；受 PrivilegesRequired=lowest 限制无法装到 Program Files
OutputBaseFilename=TemuLabelSetup
OutputDir=..\dist
PrivilegesRequired=lowest
LanguageDetectionMethod=locale
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\extension\icons\icon128.png
; SetupIconFile 嵌入 PE 资源，必须是 .ico 多分辨率图标（不接受 .png）
SetupIconFile=..\core\icons\icon128.ico
; 安装时旧版本同目录文件会被新版覆盖；卸载时清理 {app} 整目录
Uninstallable=yes

[Languages]
; ChineseSimplified.isl 项目自带（deploy/languages/），不依赖 ISCC 本地装了简体中文
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; 把整个 dist\TemuLabel_Setup\ 拷到安装目录
; recursesubdirs：递归子目录   ignoreversion：忽略文件版本号强制覆盖
Source: "..\dist\TemuLabel_Setup\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Run]
; 步骤 1：写 com.temu.label_host.json（替换 PLACEHOLDER_EXE_PATH 和 PLACEHOLDER_EXTENSION_ID）
;   - EXE 路径为 {app}\TemuLabelHost.exe，路径里的反斜杠需要转义成 \\（JSON 规则）
;   - Extension ID 用内置默认值（与 install.bat 的 DEFAULT_EXT_ID 一致）
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""(Get-Content -Raw -Encoding UTF8 '{app}\com.temu.label_host.json') -replace 'PLACEHOLDER_EXE_PATH', '{code:GetEscapedExePath}' -replace 'PLACEHOLDER_EXTENSION_ID', '{#MyDefaultExtId}' | Set-Content -Encoding UTF8 '{app}\com.temu.label_host.json'"""; \
    StatusMsg: "正在生成 Native Host manifest..."; \
    Flags: runhidden waituntilterminated

; 步骤 2：注册 Native Host 到 HKCU 注册表
;   key 默认值（/ve）= manifest 文件绝对路径
Filename: "{sys}\reg.exe"; \
    Parameters: "add ""HKCU\Software\Google\Chrome\NativeMessagingHosts\{#MyHostName}"" /ve /t REG_SZ /d ""{app}\com.temu.label_host.json"" /f"; \
    StatusMsg: "正在注册 Native Host..."; \
    Flags: runhidden waituntilterminated

[UninstallRun]
; 卸载时清理注册表项
; RunOnceId 让 Inno Setup 在 update install（先卸旧后装新）时仅执行一次此条目，
; 消除 ISCC "[UninstallRun] section entries without a RunOnceId parameter" warning
Filename: "{sys}\reg.exe"; \
    Parameters: "delete ""HKCU\Software\Google\Chrome\NativeMessagingHosts\{#MyHostName}"" /f"; \
    RunOnceId: "DelNativeHostReg"; \
    Flags: runhidden

[Code]
// =============================================================================
// Pascal Script 段
// =============================================================================

// 把 {app}\TemuLabelHost.exe 的反斜杠转义为 \\（写入 JSON 时需要）
function GetEscapedExePath(Param: String): String;
var
  ExePath: String;
begin
  ExePath := ExpandConstant('{app}\TemuLabelHost.exe');
  StringChangeEx(ExePath, '\', '\\', True);
  Result := ExePath;
end;

// 覆盖安装前清理可能残留的 native host 进程（v1.2.3 起）
//
// 为什么需要：Chrome 启动的 TemuLabelHost.exe 是 stdin/stdout 子进程，
// Inno Setup 默认 Restart Manager 只能识别 GUI 进程，看不到 native host →
// 即使弹「自动关闭应用程序」对话框，host 进程也不会被关掉。结果：[Files]
// 拷贝 TemuLabelHost.exe 时 Windows 文件锁未释放，DeleteFile 失败错误码 5
// (ACCESS_DENIED)，员工升级卡死。
//
// 修法：在拷贝文件前手动 taskkill + sleep 等 Chrome 那边 pipe disconnect
// + Windows kernel 释放 exe 文件 mapping。
//
// 注：taskkill 在进程不存在时返回 errorlevel 128，我们不区分（首装/升级都正常）。
//
// ⚠️ taskkill 只是兜底，不可靠：Chrome 若仍开着，其 service worker 可能在 taskkill
// 之后立刻重连 native messaging、重新拉起 host 进程又锁住 EXE → 覆盖失败，且这之后
// 员工再怎么重启 Chrome 也救不回来（磁盘上根本没有新 EXE），只能重装。所以装文件前
// 先弹框提示员工【手动完全退出 Chrome】——人工关 Chrome 才是确定性的解锁手段，
// taskkill 仅作为"员工没关干净时"的补救。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  MsgBox('安装前请先【完全退出 Chrome】（关闭所有窗口，并确认任务管理器里没有 chrome.exe）。'
         + #13#10 + #13#10 +
         '原因：Chrome 正在运行时会占用本程序的核心文件，导致本次更新无法生效，'
         + '而且之后重启 Chrome 也补救不了，只能重新安装一次。'
         + #13#10 + #13#10 +
         '已退出 Chrome 后，点「确定」继续安装。',
         mbInformation, MB_OK);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM TemuLabelHost.exe',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(2500);
  Result := '';
end;

// 安装完成后弹出引导对话框 + 「打开 chrome://extensions」按钮
procedure CurStepChanged(CurStep: TSetupStep);
var
  Msg: String;
  ResultCode: Integer;
  UserChoice: Integer;
  ExtensionDir: String;
begin
  if CurStep = ssDone then
  begin
    // 写版本 marker：扩展 SW 启动时调 native host 读这个文件，对比 chrome 加载版本，
    // 磁盘 > 加载 → chrome.runtime.reload() 自动应用（chrome 不监控 unpacked 扩展文件变化）。
    // 必须先于引导对话框写入（员工万一立刻 chrome reload，自检逻辑要能拿到正确值）。
    SaveStringToFile(ExpandConstant('{app}\installed_version.txt'),
                     '{#MyAppVersion}', False);

    ExtensionDir := ExpandConstant('{app}\extension');
    Msg :=
      '安装完成！' + #13#10 + #13#10 +
      '还需要在 Chrome 完成一步：' + #13#10 +
      '  1. 打开 chrome://extensions' + #13#10 +
      '  2. 右上角开启「开发者模式」' + #13#10 +
      '  3. 点「加载已解压的扩展程序」' + #13#10 +
      '  4. 选择以下文件夹：' + #13#10 +
      '     ' + ExtensionDir + #13#10 + #13#10 +
      '是否立即打开 chrome://extensions？';

    UserChoice := MsgBox(Msg, mbConfirmation, MB_YESNO);
    if UserChoice = IDYES then
    begin
      // 优先用 chrome.exe 打开 chrome://extensions
      if not ShellExec('open', 'chrome.exe', 'chrome://extensions', '',
                       SW_SHOW, ewNoWait, ResultCode) then
      begin
        // chrome.exe 找不到时 fallback 用默认浏览器协议处理
        ShellExec('open', 'chrome://extensions', '', '',
                  SW_SHOW, ewNoWait, ResultCode);
      end;
    end;
  end;
end;
