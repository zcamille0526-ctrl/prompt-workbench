#!/usr/bin/env bash
# deploy.sh — 将 prompt-workbench 部署到团队云服务器
# 用法: ./deploy.sh [端口]  默认端口 8110
set -e

SERVER_USER="zdd"
SERVER_HOST="8.133.174.178"
SERVER_PORT="22"
REMOTE_DIR="/srv/hermes-zdd/workspace/prompt-workbench"
APP_PORT="${1:-8110}"
APP_NAME="prompt-workbench"

echo "==> [1/4] 本地构建前端..."
npm run build

echo "==> [2/4] 同步文件到服务器 (排除 .env / node_modules / .git)..."
rsync -avz --progress \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist/.vite' \
  ./ "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

echo "==> [3/4] 服务器端安装依赖..."
ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" bash << EOF
  set -e
  cd "${REMOTE_DIR}"
  npm install
EOF

echo "==> [4/4] 启动 / 重启服务 (PM2, 端口 ${APP_PORT})..."
ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" bash << EOF
  set -e
  cd "${REMOTE_DIR}"

  # 检查 .env 是否存在
  if [ ! -f .env ]; then
    echo ""
    echo "  !! 警告: 服务器上还没有 .env 文件"
    echo "  !! 请先按照 .env.example 在 ${REMOTE_DIR}/.env 创建配置"
    echo "  !! 然后重新运行: ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${REMOTE_DIR} && PORT=${APP_PORT} pm2 restart ${APP_NAME} || PORT=${APP_PORT} pm2 start npm --name ${APP_NAME} -- run start'"
    exit 1
  fi

  # 用 PM2 启动或重启
  export PORT="${APP_PORT}"
  if pm2 describe "${APP_NAME}" > /dev/null 2>&1; then
    pm2 restart "${APP_NAME}" --update-env
  else
    PORT="${APP_PORT}" pm2 start npm --name "${APP_NAME}" -- run start
  fi

  pm2 save
  echo "  服务已启动: http://${SERVER_HOST}:${APP_PORT}"
EOF

echo ""
echo "部署完成! 访问: http://${SERVER_HOST}:${APP_PORT}"
