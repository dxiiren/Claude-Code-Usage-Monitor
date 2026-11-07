# Agent Instructions

## Semantic Versioning

- Use `MAJOR.MINOR.PATCH` for release versions.
- Increment PATCH for backward-compatible fixes (for example, `2.15.0` -> `2.15.1`).
- Increment MINOR for backward-compatible features and reset PATCH to zero
  (for example, `2.14.64` -> `2.15.0`). Never carry the previous patch number forward.
- Increment MAJOR for incompatible changes and reset both MINOR and PATCH to zero
  (for example, `2.15.3` -> `3.0.0`).
- Follow an explicitly requested version and do not bump an already prepared release twice.

## Local Commit Workflow

When the user asks to commit changes, complete the following workflow unless they give more
specific instructions. The commit request authorizes these preparation steps and the local
commit; do not ask for confirmation again.

1. Review the changes and select the next version.
   - Inspect `git status`, the working and staged diffs, recent commits, and `workflow.cmd`.
   - Bump the package version in `Cargo.toml` according to Semantic Versioning above,
     or use the version requested by the user. Reset PATCH to zero for a minor release.
   - If the intended version has already been bumped for this pending commit, use it rather
     than bumping it a second time.

2. Build and verify the new version.
   - Run `cargo build --release` after updating `Cargo.toml` so Cargo updates `Cargo.lock`
     and builds the executable with the new version.
   - Verify that this package's version in `Cargo.lock` matches `Cargo.toml`.
   - Run checks appropriate to the changes. For Rust changes, prefer `cargo clippy` and
     `cargo test`, following the formatting guidance in the PR workflow below.
   - Resolve new failures before committing; report unrelated existing warnings or failures.

3. Update `CHANGELOG.md`.
   - Read the existing changelog and add a dated section for the new version at the top of
     the version history, using its existing categories and style.
   - Move relevant `Unreleased` entries into that version and describe all changes included
     in the requested commit, without duplicating entries.
   - Do not add or leave an `Unreleased` heading in a release commit, even if empty.
     The version history must start with the newest dated version section.
   - Add any missing version entries since the last documented release and add the appropriate
     GitHub comparison links to the reference links at the bottom.

4. Stage and commit locally.
   - Review the final diff and stage the files covered by the commit request, including
     `Cargo.toml`, `Cargo.lock`, and `CHANGELOG.md`. Preserve unrelated local changes.
   - Prefer `workflow.cmd -c` (in PowerShell, `./workflow.cmd -c`). This commits the staged
     changes locally with the title `vVERSION`; it does not bump the version, build, update
     the changelog, or stage files, so complete those steps first.
   - Use its optional `-m` argument for concise commit body text when useful.
   - Do not add `-p` or `-d`, run `git push`, or create tags or deploy unless the user
     explicitly requests those actions. A request to commit alone means a local commit.

5. Report the result.
   - State the new version, commit hash, verification results, and resulting branch state,
     including whether it is ahead of its remote tracking branch.
   - Mention any remaining uncommitted changes and confirm that no push, tag, or deployment
     was performed unless explicitly requested.

## PR Handling Workflow

When the user pastes a GitHub pull request URL, follow this workflow unless the user gives more
specific instructions.

1. Resolve the PR context from the URL.
   - Use plain `git` as this will be authenticated.

2. Preserve PR author credit.
   - Fetch the PR branch locally rather than copying the patch into a new commit.
   - Keep the author's original commit(s) intact.
   - If fixes are required, add separate follow-up commit(s) on top of the PR branch.

3. Review for correctness before merging.
   - Read the changed code in context, not only the diff.
   - Look for regressions, race conditions, error handling gaps, unexpected behavior, missing validation, and interactions with existing state.
   - If a bug is found in the PR, fix it narrowly and explain why.
   - Avoid unrelated refactors or formatting churn.

4. Verification expectations.
   - Run the most relevant build/check commands after code changes.
   - For Rust changes, prefer: `cargo build --release`, `cargo clippy`, and `cargo test`.
   - If full `cargo fmt --check` fails on unrelated existing files, do not format the whole repo. Run `rustfmt --check` on touched Rust files and report the unrelated formatting failures.
   - Report existing warnings separately from new failures.

5. Version bump and release commit.
   - Inspect `workflow.cmd`
   - Update `Cargo.toml` according to Semantic Versioning above: fixes increment PATCH;
     new backward-compatible features increment MINOR and reset PATCH to zero
     (for example, `1.4.15` -> `1.5.0`). Breaking changes increment MAJOR and reset
     both MINOR and PATCH to zero.
   - Run `cargo build --release` so `Cargo.lock` is updated.

6. Update CHANGELOG.md
   - Read the current CHANGELOG.md and then add new entries to the top for any new versions since the last and add the links to the bottom.
   - Move any `Unreleased` entries into the appropriate dated version section and remove
     the `Unreleased` heading. Do not leave an empty placeholder in a release commit.

7. Release commit.
   - Use `workflow.cmd -c` for the version commit when requested or when matching the local release pattern.
   - Do not run `workflow.cmd -p`, `workflow.cmd -d`, `git push`, or tag/deploy steps unless the user explicitly asks for them.

8. Final response.
   - State what was inspected, what changed, and what was committed.
   - Include the resulting local branch state, especially if `main` is ahead of
     `origin/main`.
   - Clearly state which verification commands passed or failed.
   - Clearly state that push/tag/deploy steps were not run if the user asked to
     stop before them.

## Repository Notes

- This is a Rust project using Cargo.
- Keep edits scoped and prefer existing patterns.
- Use `rg` for searching when available.
- Do not revert user changes or unrelated local changes.

## For AI agents: where things live, how to build, what never to commit

- **Settings:** the widget reads `%APPDATA%\ClaudeCodeUsageMonitor\settings.json` at start. It does NOT
  watch the file: after editing it, restart the widget, or post window message `0x8005` (WM_APP+5,
  "settings updated") to the widget window class `ClaudeCodeUsageMonitor` (a child of the taskbar). Keys you will touch: `widget` (`taskbar` and `card`, each with
  `hidden`, `show_5h`, `show_7d`; for `hub.*` keys `hidden` means "differs from the default", the default being off on the strip and on elsewhere), `agent_hub_command`, `active_theme_path`. Accounts: `accounts.db` in the
  same folder (managed by the Account Manager, never edit by hand). Themes: `...\themes\*.json`.
- **Code map:** `src/widget_filter.rs` (the account / 5h / 7d filter per view, and `hub_layout`: card
  wraps at 6 per row, strip goes full -> compact -> "+N" inside a 672 px budget), `src/agent_hub.rs`
  (hub providers parsed from `agent_hub_command`), `src/theme_engine.rs` (`from_usage_filtered` builds
  the `accounts.*`, `view.*`, `hub.<id>.*`, generic `hub.slotN.*`, `hub.layout.*`, `hub.overflow.*`
  theme variables; `expand_repeats` turns a child with `"repeat": N` into N copies, `@n` = the index), `src/context_menu.rs` + `src/window/window_context_menu.rs` (the
  right-click menu), `src/localization/locales/*.toml` (every menu label needs all 14 languages),
  `web/` (Account Manager, SvelteKit), `kit/` (PowerShell install and run helpers).
- **Build and test:** `cargo test` (Rust), `cargo build --release` (exe in `target/release`),
  `just test` (all suites). Never run `just start` or `just stop` from an agent session that has
  an ask-list for them; install a new exe by stopping only the widget process id and starting the
  new file with `Start-Process`. Keep a `.bak` of the exe you replace.
- **Install on a PC:** back up `%LOCALAPPDATA%\Programs\ClaudeUsageMonitor\claude-code-usage-monitor.exe`,
  stop that one process, copy the new exe over it, start it, confirm it stays running.
- **Never commit:** tokens, passwords, `accounts.db`, `settings.json`, real e-mail addresses,
  hostnames or IP addresses of any private network, or company names. The repo is public: use
  `example.com` and placeholders. Commit with the default git identity, no co-author or session
  trailer lines.
- **Adding a menu label:** add it to `src/localization/locales/en.toml` and to every other locale
  file next to `"Manage accounts"`; a test fails if one language is missing or left in English.

## Agent Hub providers (widget): how to extend

- The hub side is `plugins/usage-otel/bin/agent_hub_widget.py` in the agent-hub repo: it prints one
  source per configured provider of any kind. A new provider needs no widget change.
- Menu actions name their view with a prefix: `toggle_account("taskbar:hub.*")`,
  `toggle_account("card:claude.work")`, `toggle_row("taskbar:7d")` (no prefix = the view that was
  right-clicked). Add a label to all 14 `src/localization/locales/*.toml`.
- Tests to run after touching this: `cargo test widget_filter`, `cargo test hub`, `cargo test context_menu`.
