# Account Manager on a server (Docker)

The same Account Manager web app as on Windows, in **server mode**: the server owns the Claude
logins and polls every account's usage itself; Windows widgets read the result over HTTPS.
Contract: `docs/account-manager-contract.md`, "Server mode (Docker) and the widget's remote mode".

## Contents

1. [Start](#start)
2. [Configuration](#configuration)
3. [Behind a Cloudflare tunnel](#behind-a-cloudflare-tunnel)
4. [With your own certificate (LAN HTTPS)](#with-your-own-certificate-lan-https)
5. [Users and screen access](#users-and-screen-access)
6. [Adding an account](#adding-an-account)
7. [The Usage screen](#the-usage-screen)
8. [Reports](#reports)
9. [Settings](#settings)
10. [Connecting a widget](#connecting-a-widget)
11. [Data, backup and upgrades](#data-backup-and-upgrades)
12. [Security notes](#security-notes)

## Start

```sh
cd deploy
cp .env.example .env        # set ACCTMGR_ADMIN_PASSWORD and ACCTMGR_PUBLIC_ORIGIN
docker compose up -d --build
docker compose ps           # STATUS shows (healthy) after ~20 s
docker compose logs -f
```

The page is then on `http://127.0.0.1:47291` on the host (loopback only). Without
`ACCTMGR_ADMIN_PASSWORD` compose refuses to start, and the container itself exits with
`FATAL: ACCTMGR_ADMIN_PASSWORD is required in server mode`. On the first start,
`ACCTMGR_ADMIN_USER` / `ACCTMGR_ADMIN_PASSWORD` create the first admin, who signs in with them (see
[Users and screen access](#users-and-screen-access)).

## Configuration

All settings live in `deploy/.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ACCTMGR_ADMIN_USER` | `Admin` | username of the first admin (case-insensitive); also the recovery account |
| `ACCTMGR_ADMIN_PASSWORD` | required | password of that admin; changing it and restarting resets that admin and signs everyone out |
| `ACCTMGR_PUBLIC_ORIGIN` | `http://127.0.0.1:47291` | the URL in the browser; drives the Host/Origin checks and the Secure cookie |
| `ACCTMGR_PUBLISH` | `127.0.0.1:47291` | host side of the port mapping |
| `ACCTMGR_TRUST_PROXY` | `0` | `1` = rate-limit sign-in per `CF-Connecting-IP` (only when reachable through the tunnel alone) |
| `ACCTMGR_POLL_SECONDS` | `300` | default usage poll interval per account (minimum 30); a value saved in Settings wins |
| `ACCTMGR_TIMEZONE` | `TZ`, then `UTC` | default time zone for report days and slots, e.g. `Asia/Kuala_Lumpur`; Settings wins |
| `ACCTMGR_HISTORY_DAYS` | `400` | default days of readings to keep (`0` = keep forever); Settings wins |
| `ACCTMGR_SESSION_SECRET` | generated | session signing secret; generated once into `/data/session-secret` |
| `ACCTMGR_NETWORK` | none | external Docker network to join (tunnel overlay) |
| `CLAUDE_CODE_VERSION` | `2.1.273` | Claude Code CLI version baked into the image |
| `CODEX_VERSION` | `0.142.5` | Codex CLI (`@openai/codex`) version baked into the image |

## Behind a Cloudflare tunnel

1. Keep `ACCTMGR_PUBLISH=127.0.0.1:47291` so nothing but the tunnel reaches the app.
2. In `.env`, set `ACCTMGR_PUBLIC_ORIGIN=https://<your hostname>`, then
   `COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml` and `ACCTMGR_NETWORK=<cloudflared's network>`.
3. In the tunnel, route the public hostname to `http://claude-usage:47291`.
4. Set `ACCTMGR_TRUST_PROXY=1`, so each visitor's sign-in attempts count against their own address.
5. `docker compose up -d`.

The app refuses any request whose `Host` is not the public hostname (`403 Forbidden host`). If you
see that behind the tunnel, set the tunnel's `httpHostHeader` to the public hostname.

## With your own certificate (LAN HTTPS)

For a LAN server without a tunnel: an nginx sidecar (`claude-usage-tls`) serves HTTPS with a
certificate the PCs already trust, and the app stays on loopback.

1. In `.env`, set `COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml`, `ACCTMGR_TLS_CERT`,
   `ACCTMGR_TLS_KEY` and `ACCTMGR_TLS_PUBLISH=0.0.0.0:<port>` (the port people open).
2. Keep `ACCTMGR_PUBLISH=127.0.0.1:47291`, and set `ACCTMGR_PUBLIC_ORIGIN=https://<host>:<port>` and
   `ACCTMGR_TRUST_PROXY=1`.
3. `docker compose up -d`. `http://` typed at that port is redirected to `https://`.

**After a host reboot** the two containers come back in any order: restart policies do not follow
`depends_on`. That is handled:

- nginx looks the app up through Docker's DNS on every request (answer cached for 10 seconds), so
  when nginx starts first it answers `502 Bad Gateway` for a few seconds and then recovers by itself.
- It proxies to the alias `claude-usage.internal`, which the overlay gives the app. A name with a
  dot matters: some LAN resolvers answer an unknown single-label name with an outside address, and
  nginx would then send requests off the host. A `.internal` name gets "not found" instead.

After changing `nginx-tls.conf`, recreate the sidecar so it reads the new file:
`docker compose up -d --force-recreate claude-usage-tls`. A plain `up -d` keeps the old one, because
the file is mounted on its own and an edited or re-checked-out file is a new file to Docker.

## Users and screen access

Each person has their own username and password, and a list of screens they may open: Accounts,
Usage, Report, Widget tokens, Settings and Users. Anything not on the list is closed to them (a page
redirects to their first allowed screen, an API call answers `403`). A user who has the **Users**
screen is an admin: only they can add users, change screens, reset passwords and remove users. Apart
from the sign-in page, `/healthz` is the only page open without signing in, and the widget endpoint
takes a token instead (see [Connecting a widget](#connecting-a-widget)).

- **First admin.** On the first start, `ACCTMGR_ADMIN_USER` / `ACCTMGR_ADMIN_PASSWORD` create a user
  with every screen. After that the environment is no longer "the" login: other users can be added
  and each user can change their own password under **Change password**.
- **New users.** An admin enters a username (2 to 24 characters: letters, digits, dot, dash or
  underscore; stored in lower case), a temporary password and the screens. The user must choose their
  own password at first sign-in, and nothing else opens until they have.
- **Password reset.** An admin can reset another user's password. It makes a new temporary password,
  shown once. The user is signed out everywhere and must choose a new password at next sign-in.
- **Guard rails.** Nobody can remove their own Users screen or remove themselves, and the last user
  with the Users screen cannot lose it or be removed.
- **Locked out.** Change `ACCTMGR_ADMIN_PASSWORD` in `.env` and restart (`docker compose up -d`).
  That admin gets the environment password and every screen again, and every session ends. The same
  happens at any start when no user is left who can manage users.
- **Upgrading from an older version.** Sessions from before users existed carry no user, so they are
  dropped: everyone signs in once more.

Minimum password length, how long a sign-in lasts and the sign-in rate limit are set in
[Settings](#settings).

## Adding an account

Sign in with a user who has the Accounts screen, type a name, click **Start**. The server runs `claude auth login --claudeai` inside the
container and shows **Open sign-in page**. Open it in your own browser (a private window, so it does
not sign in as someone already signed in), sign in, click Authorize, copy the code, and paste it into
the page. The server never calls Anthropic OAuth endpoints itself; the CLI does the exchange and
keeps the login in `/data/accounts/<id>`.

Usage is polled right after the login, then at the collection interval (set in Settings;
`ACCTMGR_POLL_SECONDS` until one is saved), the same way the widget polls (same endpoint and headers, token refresh by running the CLI, 429 / Retry-After
honoured).

### Codex (ChatGPT) accounts

Pick **Codex** before **Start**. The server asks the Codex CLI in the container for a ChatGPT sign-in
link (`codex app-server`, the CLI's own login server, with `CODEX_HOME=/data/accounts/<id>`) and
shows **Open sign-in page**. Open it in your own browser (a private window), sign in. Your browser
then lands on a `http://localhost:1455/auth/callback?...` page that does not load: that is expected,
because the CLI waiting for it runs inside the container. Copy that page's full address and paste it
into the manager. The server checks it (host `localhost` / `127.0.0.1`, port `1455`, path
`/auth/callback` only) and replays it to the CLI's own `127.0.0.1:1455` inside the container, which
finishes the login and writes `auth.json`. The server never calls OpenAI OAuth endpoints itself.

Status comes from `codex login status`; the email from the id_token in `auth.json`. Usage is polled
from `https://chatgpt.com/backend-api/wham/usage` like the widget (same headers incl.
`ChatGPT-Account-Id`, 5-hour / weekly windows by length, a rejected token refreshed by the CLI,
429 / Retry-After honoured). Only one Codex sign-in can wait at a time (the CLI has one callback
port); starting another cancels the first.

## The Usage screen

Shows each enabled account's two usage windows. In the web app they are called **Hourly session**
(the 5-hour window) and **Weekly session** (the 7-day window); both names can be changed in
[Settings](#settings). The Windows widget still shows them as 5h / 7d.

**Refresh now** reads every enabled account straight away instead of waiting for the next scheduled
reading. The same button is on the Accounts screen. It calls `POST /api/usage/refresh`. Accounts the
provider has rate limited are skipped until their cooldown ends. **Wait between manual refreshes** in
Settings spaces the button out for everyone; a refresh inside that time answers `429` with
`Retry-After`.

## Reports

Every successful poll is kept in the `usage_samples` table: one row per account per reading. A failed
poll stores nothing, so an outage shows as a gap and not as zero use. The **Report** screen cuts those
readings into time slots (by default Morning, Lunch, Afternoon and After hours) for a day, week or
month, in the configured time zone.

**Download** gives the report as Word (`.docx`), PDF or CSV. The file is built in the browser; the
server only supplies the numbers. An account that was removed keeps the name it last had in old
reports (table `report_accounts`).

- History starts at the first reading after this version is installed. Earlier usage is not
  back-filled.
- Storage grows with the number of accounts and the interval: at the default 5 minutes that is about
  288 rows per account per day. Readings older than **Keep history for** are deleted (checked about
  once a day while polling). The default is 400 days, and `0` keeps everything.

## Settings

The **Settings** screen changes the items below. Values are saved in the `app_settings` table and
apply without a restart. Until a value is saved, the built-in default applies, and three of them
start from an environment variable:

- Collect usage every: `ACCTMGR_POLL_SECONDS` (default 300 seconds).
- Time zone: `ACCTMGR_TIMEZONE`, else `TZ`, else `UTC`. Used for report days and slots.
- Keep history for: `ACCTMGR_HISTORY_DAYS` (default 400, `0` = keep forever).

Groups, with the labels shown on screen:

1. **Time slots.** The named time ranges a report is cut into.
2. **Data collection.** Collect usage every, Keep history for, Time zone.
3. **Names and colours on the Usage page.** Name of the 5-hour window, Name of the 7-day window,
   Turn amber at, Turn red at, Page refreshes itself every, Wait between manual refreshes.
4. **Report.** Open the report showing, Default period, Count as "limit reached" at, Mark an account
   "not used" below.
5. **Downloaded document.** Report title, Company name, Footer text, Notice on page 2, Default
   download format, Include cover page, Include notice and contents page, Show company logo.
6. **Sign-in and security.** Stay signed in for, Shortest password allowed, Wrong passwords before a
   pause, Length of the pause, Theme for new users.

## Connecting a widget

Open **Widget tokens** (needs that screen), create a token (it is shown once), and put these in the widget's
`%APPDATA%\ClaudeCodeUsageMonitor\settings.json`:

```json
"remote_server_url": "https://<your hostname>",
"remote_server_token": "<the token>"
```

The widget reads `GET /api/v1/widget` with `Authorization: Bearer <token>`. **Revoke** stops a
token at once (`401`).

## Data, backup and upgrades

Everything is in the `claude-usage-data` volume (`/data`): `accounts.db` (accounts, users, settings
and the usage history), `session-secret`, and one config folder per account under `accounts/`
(Claude: `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME` with `auth.json`). Back up the volume to keep the
logins, the users and the report history.

```sh
docker run --rm -v claude-usage_claude-usage-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/claude-usage-data.tgz -C /data .
```

Upgrade the CLIs: change `CLAUDE_CODE_VERSION` / `CODEX_VERSION`, then `docker compose up -d --build`.
The Claude CLI's own auto-updater is off in the image; the Codex CLI only updates when asked
(`codex update`), which nothing in the image runs.

## Security notes

- The container runs as the non-root `node` user; apart from the sign-in page, `/healthz` is the only
  page without sign-in and it returns just `ok`. The widget endpoint takes a token instead.
- Passwords are stored as scrypt hashes. Each request is checked against the signed-in user's
  screens, and a route that belongs to no screen is open to admins only.
- Sign-in: by default 5 failures per 15 minutes per client address, then `429` with `Retry-After`
  (both numbers are in Settings); a global cap of 30 failures covers many addresses. Failed attempts are logged with address and
  time only (`docker compose logs | grep "failed sign-in"`), never what was typed.
- Session cookie: `HttpOnly`, `SameSite=Strict`, and `Secure` (as `__Host-acctmgr_session`) when the
  public origin is https. Sessions and widget tokens are stored as SHA-256 hashes only.
- Tokens and Claude / Codex credentials are never returned by any endpoint or written to logs.
