@echo off
:: 切到 UTF-8 codepage，避免 Windows cmd 默认 GBK 解码 UTF-8 中文 echo 时乱码
chcp 65001 >nul
setlocal
:: %~dp0 = native_host\build\；.. = native_host\（cwd 固定为顶层 native_host 目录）
cd /d %~dp0..

echo ============================================
echo Temu Auto Label - 构建 Native Host EXE
echo ============================================

:: 检查 PyInstaller
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 PyInstaller，请先执行：
    echo   pip install -r requirements.txt
    if not defined PACKAGE_ALL pause
    exit /b 1
)

:: --specpath build 让 spec 落到 build\ 子目录，PyInstaller 在 spec 模式下
:: --add-data 的相对路径以 spec 所在目录（build\）为基准，因此 resources 前面要加 ..\
:: --hidden-import handlers.bartender：bartender 在 main._generate_label 内惰性 import，
:: PyInstaller 静态分析扫不到，必须显式声明否则 EXE 缺这个模块
pyinstaller ^
  --onefile ^
  --name TemuLabelHost ^
  --distpath . ^
  --workpath build\work ^
  --specpath build ^
  --hidden-import win32com.client ^
  --hidden-import win32com.server.util ^
  --hidden-import handlers.bartender ^
  --collect-all pymupdf ^
  --add-data "..\resources\background.png;resources" ^
  main.py

if errorlevel 1 (
    echo [失败] 构建出错，查看上方日志
    if not defined PACKAGE_ALL pause
    exit /b 1
)

echo.
echo [成功] 输出：native_host\TemuLabelHost.exe
echo 接下来运行 native_host\install.bat 完成注册
:: package_all.py 调用时设了 PACKAGE_ALL=1，跳过 pause 避免 subprocess 死锁；
:: 手动跑 build.bat 时变量未定义，保留 pause 防止 cmd 窗口闪退丢日志
if not defined PACKAGE_ALL pause
endlocal
