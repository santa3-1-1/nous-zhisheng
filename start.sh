#!/bin/bash
# 知声 server 守护脚本 - 崩溃自动重启

cd "$(dirname "$0")"

# 清除代理
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

echo "🔄 知声 Server 守护进程启动"
echo "   按 Ctrl+C 彻底停止"
echo ""

while true; do
  echo "[$(date '+%H:%M:%S')] 启动 server..."
  node server/index.js
  EXIT_CODE=$?
  
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] Server 正常退出"
    break
  fi
  
  echo "[$(date '+%H:%M:%S')] Server 崩溃 (exit code: $EXIT_CODE)，3秒后自动重启..."
  sleep 3
done
