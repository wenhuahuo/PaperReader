@echo off
setlocal
cd /d "%~dp0\.."

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 LTS 版本：https://nodejs.org
  echo 安装完成后关闭此窗口，重新双击启动。
  pause
  exit /b 1
)

echo 正在安装依赖…
call npm install
if errorlevel 1 (
  echo 依赖安装失败。
  pause
  exit /b 1
)

echo 正在打包页面…
call npm run build
if errorlevel 1 (
  echo 页面打包失败。
  pause
  exit /b 1
)

echo 正在启动 Paper Reader…
echo 请保持本窗口开着。关闭窗口即退出。
start "" http://127.0.0.1:3080
node src/server/index.js
pause
