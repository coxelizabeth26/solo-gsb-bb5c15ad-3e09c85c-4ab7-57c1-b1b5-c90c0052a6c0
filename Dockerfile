# 无线麦克风频率协调工具
FROM node:20-bookworm-slim

# better-sqlite3 优先使用预编译二进制；若下载失败则回退源码编译，需要构建工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单，充分利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用源码
COPY server.js db.js ./
COPY lib ./lib
COPY public ./public

# SQLite 数据目录（可挂载卷持久化）
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# 启动即自动初始化数据库（CREATE TABLE IF NOT EXISTS）
CMD ["node", "server.js"]
