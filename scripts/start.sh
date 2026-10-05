#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
url="http://127.0.0.1:3080"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "未找到 Node.js。请先安装 LTS 版本：https://nodejs.org"
  echo "安装完成后关闭此窗口，重新双击启动。"
  read -r -p "按回车键退出…" _
  exit 1
fi

echo "正在安装依赖…"
npm install

echo "正在打包页面…"
npm run build

echo "正在启动 Paper Reader…"
echo "请保持本窗口开着。关闭窗口即退出。"
node src/server/index.js &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if curl -fsS "$url/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "服务启动失败，请把上面的报错发给分享者。"
    read -r -p "按回车键退出…" _
    exit 1
  fi
  sleep 0.2
done

echo "浏览器打开 $url"
case "$(uname -s)" in
  Darwin) open "$url" ;;
  MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "$url" ;;
  *) xdg-open "$url" >/dev/null 2>&1 || true ;;
esac

wait "$server_pid"
