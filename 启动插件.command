#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo '请先安装 Node.js 22.12 或更新版本，再双击此文件。'
  read '?按回车退出…'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
echo '请在多维表格 → 插件 → 自定义插件中填写：http://127.0.0.1:5173/'
echo '请保留本窗口；停止服务按 Ctrl+C。'
npm run dev
