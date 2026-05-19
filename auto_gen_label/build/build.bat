@echo off
setlocal
cd /d %~dp0..

echo ============================================
echo Temu Auto Label - 构建 Native Host EXE
echo ============================================

:: 检查 PyInstaller
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 PyInstaller，请先执行：
    echo   pip install -r native_host\requirements.txt
    pause
    exit /b 1
)

pyinstaller ^
  --onefile ^
  --name TemuLabelHost ^
  --distpath native_host ^
  --workpath build\work ^
  --specpath build ^
  --hidden-import win32com.client ^
  --hidden-import win32com.server.util ^
  --collect-all pymupdf ^
  --add-data "native_host\resources\background.png;resources" ^
  native_host\main.py

if errorlevel 1 (
    echo [失败] 构建出错，查看上方日志
    pause
    exit /b 1
)

echo.
echo [成功] 输出：native_host\TemuLabelHost.exe
echo 接下来运行 native_host\install.bat 完成注册
pause
endlocal
