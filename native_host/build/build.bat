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
:: --hidden-import：main.py 的 DISPATCH handler 内惰性 import 的模块，PyInstaller 静态分析
:: 扫不到函数体内的 import，必须显式声明否则 EXE 缺模块（运行时报 ImportError / 静默退化）。
:: bartender(generate_label)/text_refine(refine_title)/image_optimize(optimize_image) 都是惰性 import；
:: config 被 text_refine._select_provider 和 main._llm_config_action 内部 import（LLM key 配置源，
:: 缺它会致 text_refine 永远退化 mock、llm_config action 报错，且 mock 不报错难察觉——必须显式声明）。
pyinstaller ^
  --onefile ^
  --name TemuLabelHost ^
  --distpath . ^
  --workpath build\work ^
  --specpath build ^
  --hidden-import win32com.client ^
  --hidden-import win32com.server.util ^
  --hidden-import handlers.bartender ^
  --hidden-import handlers.text_refine ^
  --hidden-import handlers.image_optimize ^
  --hidden-import config ^
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
