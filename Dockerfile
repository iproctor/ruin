# Stage 1: build all packages
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/ai/package.json packages/ai/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages/engine packages/engine/
COPY packages/ai packages/ai/
COPY packages/client packages/client/
COPY packages/server packages/server/
COPY tsconfig.base.json ./
RUN pnpm build

# Stage 2: production image
FROM node:22-alpine AS runner
WORKDIR /app
RUN npm install -g pnpm
COPY --from=builder /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=builder /app/packages/engine/package.json packages/engine/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/ai/package.json packages/ai/
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/packages/engine/dist packages/engine/dist/
COPY --from=builder /app/packages/server/dist packages/server/dist/
COPY --from=builder /app/packages/ai/dist packages/ai/dist/
COPY --from=builder /app/packages/client/dist packages/client/dist/
EXPOSE 3001
CMD ["node", "packages/server/dist/index.js"]
