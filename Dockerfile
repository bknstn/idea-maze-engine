ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build

WORKDIR /opt/idea-maze-engine

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# esbuild is pinned by the lockfile through the locked tsx toolchain. Bundle
# application modules while leaving Node built-ins and production packages
# external so better-sqlite3 keeps its native binding and normal package lookup.
RUN ./node_modules/.bin/esbuild src/idea-maze/scripts/research-mcp.ts \
      --bundle --platform=node --format=esm --packages=external --target=node22 \
      --outfile=dist/research-mcp.mjs \
    && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    IDEA_MAZE_HOME=/data \
    IDEA_MAZE_MCP_HTTP_HOST=127.0.0.1 \
    IDEA_MAZE_MCP_HTTP_PORT=8787

WORKDIR /opt/idea-maze-engine

RUN mkdir -p /data /backups \
    && chown 10001:10001 /data /backups

COPY --from=build --chown=10001:10001 /opt/idea-maze-engine/dist/research-mcp.mjs ./research-mcp.mjs
COPY --from=build --chown=10001:10001 /opt/idea-maze-engine/node_modules ./node_modules
COPY --chown=10001:10001 deploy/data-transfer.mjs ./data-transfer.mjs
COPY --chown=10001:10001 LICENSE ./LICENSE

USER 10001:10001
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/opt/idea-maze-engine/research-mcp.mjs"]
