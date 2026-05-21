@echo off
chcp 65001 > nul
setlocal

set SCRIPT_DIR=%~dp0
set EXE_PATH=%SCRIPT_DIR%TemuLabelHost.exe
set MANIFEST_SRC=%SCRIPT_DIR%com.temu.label_host.json
set MANIFEST_DEST=%APPDATA%\TemuLabel\com.temu.label_host.json
set REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.temu.label_host

echo ============================================
echo Temu Auto Label - Native Host 安装程序
echo ============================================
echo.

if not exist "%EXE_PATH%" (
    echo [错误] 未找到 TemuLabelHost.exe: %EXE_PATH%
    echo 请先运行 build\build.bat 构建 EXE
    pause
    exit /b 1
)

:: 读取 Extension ID
:: 优先级： 命令行参数 > 内置默认（来自 manifest.template.json 的 key 字段固定 ID）
:: 用法： install.bat [extension_id]
:: 如果你 fork 项目并自己生成了 key，请修改下面的 DEFAULT_EXT_ID
set DEFAULT_EXT_ID=dnamfbakkceljnlhiekgjbjchgooaljm
if not "%~1"=="" (
    set EXT_ID=%~1
    echo Extension ID: %~1 [来自命令行参数]
) else (
    set EXT_ID=%DEFAULT_EXT_ID%
    echo Extension ID: %DEFAULT_EXT_ID% [来自内置默认]
)

:: 创建目标目录
if not exist "%APPDATA%\TemuLabel" mkdir "%APPDATA%\TemuLabel"

:: 写入 Manifest（替换占位符）
powershell -Command "(Get-Content '%MANIFEST_SRC%') -replace 'PLACEHOLDER_EXE_PATH', '%EXE_PATH:\=\\%' -replace 'PLACEHOLDER_EXTENSION_ID', '%EXT_ID%' | Set-Content '%MANIFEST_DEST%'"

:: 复制 EXE
copy /Y "%EXE_PATH%" "%APPDATA%\TemuLabel\TemuLabelHost.exe" >nul

:: 注册到注册表
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_DEST%" /f >nul

echo.
echo [成功] Native Host 已注册
echo   EXE: %APPDATA%\TemuLabel\TemuLabelHost.exe
echo   Manifest: %MANIFEST_DEST%
echo.
echo 请重启 Chrome 后加载插件。
pause
endlocal
