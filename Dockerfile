# 图译空间生产镜像（多阶段构建，Linux 下启用 standalone 产物）
#
# 构建：  docker build -t tuanyi-space .
# 运行：  docker run -d -p 3000:3000 \
#           -e SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))") \
#           -v tuanyi-data:/app/data \
#           tuanyi-space
#
# 说明：
# - 数据（SQLite + 图片）全部落在 /app/data，务必挂载 volume 持久化
# - better-sqlite3 / sharp 在 linux x64/arm64 有预编译产物，无需容器内编译
# - 首次启动自动建库建表（幂等迁移），无需手动初始化
# - 管理员指定：docker exec -it <容器> node scripts/admin.mjs set <用户名>
#   （scripts 目录已复制进镜像；数据库路径与站点一致读 DATA_DIR）

# ---------- 依赖层 ----------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 构建层 ----------
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 运行层 ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=data
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 备份脚本与 admin CLI（运行期运维工具，读同一 DATA_DIR）
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
