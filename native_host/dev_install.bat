@echo off
chcp 65001 >nul 2>&1
setlocal
:: pushd 比 cd /d 友好：支持 UNC 路径（\\wsl$\... 或 \\wsl.localhost\...），会自动分配临时盘符
pushd %~dp0

echo ============================================
echo Temu Auto Label - 开发模式 Native Host 注册
echo （直接用 Python 运行，无需先打包 EXE）
echo ============================================
echo.

:: 找 Python 路径
for /f "delims=" %%i in ('python -c "import sys; print(sys.executable)"') do set PYTHON_EXE=%%i
if "%PYTHON_EXE%"=="" (
    echo [错误] 找不到 Python，请确认已安装并在 PATH 中
    pause & exit /b 1
)
echo Python: %PYTHON_EXE%

:: 当前脚本目录（native_host）
set HOST_DIR=%~dp0
set MAIN_PY=%HOST_DIR%main.py
:: wrapper bat 必须放在 Windows 本地路径下：chrome native messaging 不接受
:: UNC 路径（\\wsl.localhost\...）作为 manifest.path 的可执行文件位置。
:: wrapper 内部仍用 UNC 调 main.py，python.exe 自己能读 UNC 路径。
set WRAPPER_BAT=%APPDATA%\TemuLabel\run_host.bat
set MANIFEST_DEST=%APPDATA%\TemuLabel\com.temu.label_host.json
set REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.temu.label_host

:: 读取 Extension ID
:: 优先级： 命令行参数 > 内置默认（来自 manifest.template.json 的 key 字段固定 ID）
:: 用法： dev_install.bat [extension_id]
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

:: 生成 wrapper bat（Native Messaging 只能调用可执行文件或 bat）
:: wrapper 内部用 pushd 而不是 cd /d，因为 HOST_DIR 可能是 UNC 路径
(
echo @echo off
echo pushd "%HOST_DIR%"
echo "%PYTHON_EXE%" "%MAIN_PY%"
echo popd
) > "%WRAPPER_BAT%"
echo [OK] 生成 wrapper: %WRAPPER_BAT%

:: 生成 manifest JSON
set WRAPPER_ESCAPED=%WRAPPER_BAT:\=\\%
(
echo {
echo   "name": "com.temu.label_host",
echo   "description": "Temu Auto Label Native Host",
echo   "path": "%WRAPPER_ESCAPED%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://%EXT_ID%/"
echo   ]
echo }
) > "%MANIFEST_DEST%"
echo [OK] 生成 manifest: %MANIFEST_DEST%

:: 注册表
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_DEST%" /f >nul 2>&1
echo [OK] 注册表已写入

echo.
echo ============================================
echo 安装完成！请重启 Chrome 后测试。
echo ============================================
echo.
echo 调试提示：
echo   日志文件: %HOST_DIR%temu_label_host.log
echo   手动测试: python "%MAIN_PY%"
echo.
pause
:: 兜底清理 chcp redirect cmd bug 可能误创建的 "nul\r" 文件
if exist nul* del /q /f nul* 2>nul
popd
endlocal
