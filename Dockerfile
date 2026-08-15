FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    BOXPILOT_HOST=0.0.0.0 \
    BOXPILOT_PORT=8787 \
    BOXPILOT_STATE_DIRECTORY=/tmp/boxpilot \
    BOXPILOT_COOKIE_SECURE=false

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/v1/health >/dev/null || exit 1

CMD ["npm", "start"]
