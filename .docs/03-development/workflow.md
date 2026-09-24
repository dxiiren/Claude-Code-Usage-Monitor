# Development workflow

## Branch, change, test, PR

1. Branch off `main` (`feat/…`, `fix/…`, `docs/…`); never commit to `main` directly.
2. Change code — the contract in `docs/account-manager-contract.md` first if the DB, the server API
   or remote mode changes.
3. Run the suites you touched, then `just test` before the PR:

   | Suite | Command | Covers |
   | --- | --- | --- |
   | Rust | `just test-rust` | widget: DB reading, remote mode, updater, themes |
   | Web unit | `cd web; npm test` | theme, DB, status, auth, poller, widget API, guards |
   | Web e2e (local) | `cd web; npm run test:e2e` | real browser against a built server + fake CLI |
   | Web e2e (server) | `cd web; npx playwright test -c playwright.server.config.ts` | login, tokens, rate limit, polling |

   e2e builds into `web/build-e2e/`, never `web/build/` (the live local manager serves from that).
4. Open a PR. CI (`.github/workflows/tests.yml`) runs fmt, clippy, cargo test, web unit + both e2e
   suites, a PowerShell 5.1 kit check, and a Docker image build/run. Merge only when green.

## CI: GitHub and Gitea

The repo is mirrored to Gitea (`gitea.kollect.biz/akmal/Claude-Code-Usage-Monitor`), whose shared
runners are Linux-only (`ubuntu-latest`). The two CI systems split the work:

| Runs on | Workflow | Jobs |
| --- | --- | --- |
| GitHub | `.github/workflows/tests.yml` | Rust fmt/clippy/test, web unit, both e2e suites, kit check, Docker image (Windows + Ubuntu) |
| GitHub | `.github/workflows/release.yml` | tag `v*` → release exe (+ WinGet upstream only) |
| GitHub | `.github/workflows/dependency-security.yml` | cargo-audit, cargo-deny |
| Gitea | `.gitea/workflows/ci.yml` | web unit + build, web e2e (server mode), Docker image build + smoke run |

- Gitea reads only `.gitea/workflows/` once that directory exists (its `[actions] WORKFLOW_DIRS`
  default is `.gitea/workflows, .github/workflows`, and the first one present wins). So the GitHub
  workflows never run on Gitea.
- Gitea runs on push to `main` and on PRs, never on tags, because releases stay on GitHub.
- The Docker job's smoke script is `.gitea/ci/scripts/docker_smoke.sh`. It checks `/healthz` 200,
  `/` 303, `/api/v1/widget` 401, that the image refuses to start without `ACCTMGR_ADMIN_PASSWORD`,
  and that `claude --version` works.
- Images come from the LAN Harbor mirror (`kcr.kollect.biz/base-image`), not Docker Hub.

## Try changes live

- Web: `just web-dev` (hot reload), or `just manager-build` to rebuild the running local manager.
- Widget: `just widget-build` (cargo release build, installs over the current widget).
- Server image: `just docker-build` then `just docker-run` → http://127.0.0.1:47391.

## Releases

The widget's updater follows this fork's GitHub releases.

1. Bump `version` in `Cargo.toml` (build once so `Cargo.lock` follows), PR, merge.
2. `git tag -a vX.Y.Z origin/main -m "…"` and push the tag — `release.yml` builds and publishes
   `claude-code-usage-monitor.exe` (WinGet submission is upstream-only).
3. PCs update with `just widget-update`.

## Conventions

- Commits: Conventional Commits (`feat(web): …`, `fix(kit): …`, `test: …`).
- The PowerShell kit must run on Windows PowerShell 5.1 (no ternary / `??`); non-ASCII via `[char]`.
- Never commit `deploy/.env`, account data, tokens or `accounts.db`.
