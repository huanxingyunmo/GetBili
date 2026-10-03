# syntax=docker/dockerfile:1
# GetBili 自托管镜像：两阶段构建，最终镜像只含 alpine + Node + 单文件产物。
#
# 构建：  docker build -t getbili .
# 运行：  docker run -d -p 8787:8787 --env-file .env getbili
#         （.env 至少提供 ADMIN_TOKEN 与 BILI_COOKIE；纯 HTTP 访问需加 COOKIE_SECURE=false）
# 编排：  docker compose up -d
#
# 环境变量（全部可选注入，缺省行为见 README）：
#   ADMIN_TOKEN / BILI_COOKIE / COOKIE_SECURE / PORT / HOST
#   KV_REST_API_URL / KV_REST_API_TOKEN（策略持久化）
#   UPSTREAM_PROXY_BASE（上游出口代理）

# ---------- 构建阶段：装依赖 + esbuild 打包成自包含单文件 ----------
FROM node:22-alpine AS build
WORKDIR /app

# corepack 提供 pnpm，版本与 lockfile 生成端一致，保证 frozen-lockfile 可复现
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# 先拷贝清单文件，依赖层可被缓存复用
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# 打包生产入口：hono + @hono/node-server 全部内联，产物零 node_modules 依赖
RUN node node_modules/esbuild/bin/esbuild scripts/server.ts \
      --bundle --format=esm --platform=node --target=node20 \
      --outfile=dist/server.mjs

# ---------- 运行阶段：极小镜像 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/dist/server.mjs ./server.mjs
EXPOSE 8787

# 容器内自检：健康检查接口为公开端点，不依赖任何环境变量
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
