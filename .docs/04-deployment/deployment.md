# Deployment (server mode, Docker)

The full reference is [`deploy/README.md`](../../deploy/README.md); this page is the short path.

## 1. First deploy

```bash
git clone https://github.com/dxiiren/Claude-Code-Usage-Monitor ~/claude-usage
cd ~/claude-usage/deploy
cp .env.example .env && chmod 600 .env
# edit .env: ACCTMGR_ADMIN_USER, ACCTMGR_ADMIN_PASSWORD, ACCTMGR_PUBLIC_ORIGIN
docker compose up -d --build
curl -s http://127.0.0.1:47291/healthz   # -> ok
```

The container refuses to start without `ACCTMGR_ADMIN_PASSWORD`. Data (accounts.db, per-account
Claude logins, session secret) lives in the `claude-usage-data` volume.

## 2. Pick how people reach it

| Setup | `.env` | Notes |
| --- | --- | --- |
| **Cloudflare tunnel** (public) | `COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml`, `ACCTMGR_NETWORK=<cloudflared network>`, `ACCTMGR_PUBLISH=127.0.0.1:47291`, `ACCTMGR_TRUST_PROXY=1`, `ACCTMGR_PUBLIC_ORIGIN=https://<hostname>` | Add a tunnel public hostname → `http://claude-usage:47291` and a proxied CNAME. HTTPS by Cloudflare. |
| **Own certificate** (LAN HTTPS) | `COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml`, `ACCTMGR_TLS_CERT`, `ACCTMGR_TLS_KEY`, `ACCTMGR_TLS_PUBLISH=0.0.0.0:<port>`, `ACCTMGR_PUBLISH=127.0.0.1:47291`, `ACCTMGR_TRUST_PROXY=1`, `ACCTMGR_PUBLIC_ORIGIN=https://<host>:<port>` | nginx sidecar; `http://` at that port redirects to `https://`. PCs must trust the certificate. |
| **Plain HTTP** (LAN only) | `ACCTMGR_PUBLISH=0.0.0.0:<port>`, `ACCTMGR_PUBLIC_ORIGIN=http://<host>:<port>` | The password travels unencrypted — prefer one of the above. |

The app accepts exactly one origin: open it by the address in `ACCTMGR_PUBLIC_ORIGIN`, not by IP.

## 3. Operate

- **Update:** `git pull && docker compose up -d --build` in `deploy/`.
- **Change settings** (password, poll interval): edit `.env`, then `docker compose up -d`.
- **Logs:** `docker logs claude-usage` (failed sign-ins are logged with IP and time, never passwords).
- **Freshness:** `ACCTMGR_POLL_SECONDS=120` is a good balance; the poller backs off on 429.
- **Security:** sign-in is rate limited (5 failures / 15 min per client, global cap). Use a long
  password on anything internet-facing.
