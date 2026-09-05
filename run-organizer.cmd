@echo off
setlocal
chcp 65001 >nul
title Orbit Organizer - ダウンロード整理
cd /d "%~dp0"

echo.
echo Downloads の整理候補を確認しています...
echo.
node organize.mjs preview
if errorlevel 1 goto :error

echo.
choice /C YN /N /M "この内容で整理しますか？ [Y/N] "
if errorlevel 2 goto :cancel

echo.
node organize.mjs apply
if errorlevel 1 goto :error
echo.
echo 整理が完了しました。
pause
exit /b 0

:cancel
echo.
echo キャンセルしました。ファイルは移動していません。
pause
exit /b 0

:error
echo.
echo エラーが発生しました。上のメッセージを確認してください。
pause
exit /b 1
