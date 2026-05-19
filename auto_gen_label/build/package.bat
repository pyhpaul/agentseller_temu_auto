@echo off
echo ============================================
echo [DEPRECATED] auto_gen_label/build/package.bat
echo ============================================
echo.
echo This script is deprecated after the multi-feature refactor.
echo Use the top-level packaging entry instead:
echo.
echo   cd ..\..\
echo   python build\package_all.py
echo.
echo The new entry handles: extension dist build, native_host EXE build,
echo TAL_DEBUG release replacement, and setup folder assembly.
echo See project root CLAUDE.md for details.
echo.
exit /b 1
