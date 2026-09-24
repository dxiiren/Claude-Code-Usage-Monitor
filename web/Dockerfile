# Claude Account Manager, server mode (docs/account-manager-contract.md, "Server mode (Docker)").
# Build from web/:   docker build -t claude-usage web
# Run:               see deploy/README.md (docker compose) -- needs ACCTMGR_ADMIN_PASSWORD.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- build: SvelteKit -> build/ (adapter-node bundles every dependency) ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime

# Claude Code CLI, pinned. The npm package ships a native binary per platform through optional
# dependencies (@anthropic-ai/claude-code-linux-x64 / -arm64 for glibc), installed by npm itself;
# it runs headless (auth login prints the URL to $BROWSER / stdout, auth status and -p work without a TTY).
# Bump with: docker compose build --build-arg CLAUDE_CODE_VERSION=<x.y.z>
ARG CLAUDE_CODE_VERSION=2.1.273
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& npm cache clean --force \
	&& claude --version

# DISABLE_AUTOUPDATER: the CLI must never update itself inside the image; bump CLAUDE_CODE_VERSION instead.
ENV NODE_ENV=production \
	ACCTMGR_MODE=server \
	ACCTMGR_DATA_DIR=/data \
	HOST=0.0.0.0 \
	PORT=47291 \
	DISABLE_AUTOUPDATER=1 \
	HOME=/home/node

WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY start.js ./start.js

# Non-root: the image's built-in `node` user (uid 1000) owns the data volume.
RUN mkdir -p /data/accounts && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 47291

# /healthz: no auth, no data; any Host is accepted for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||47291)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini reaps the CLI processes a login / token refresh starts.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "start.js"]
