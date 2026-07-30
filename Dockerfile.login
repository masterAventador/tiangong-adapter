FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY Dockerfile.tiangong Dockerfile.login compose.tiangong.yaml README.md ./
COPY gateway ./gateway
COPY login ./login
COPY src ./src
COPY tests ./tests
RUN npm test

FROM node:24-alpine AS runtime

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=8081
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist/src/login.js ./dist/src/login.js
COPY --from=build --chown=node:node /app/dist/src/login-server.js ./dist/src/login-server.js

USER node
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/login-server.js"]
