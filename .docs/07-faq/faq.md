# FAQ

**Does this use SQLite everywhere?**
Yes. PC: `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db`. Server: `/data/accounts.db` in the Docker
volume. The Claude logins themselves are files in each account's config folder.

**Does it handle Codex (ChatGPT) accounts too?**
Yes. Pick **Codex** when adding an account. On a PC the private Edge window finishes the sign-in by
itself; on a server you paste the `localhost:1455` address the browser ends on (that page fails to
load, which is expected). Codex rows carry a small "Codex" tag on the page and on the widget card.
Add them one at a time — only one Codex sign-in can wait at once.

**Do I need the Codex CLI?**
Only for Codex accounts. `setup.ps1` installs it (`npm install -g @openai/codex`) and warns if it
cannot; the Docker image already includes it. Your own `%USERPROFILE%\.codex` (or `~/.codex`) is
never used, changed or deleted — each Codex account has its own folder.

**Why does the local version not run in Docker?**
It opens the Edge sign-in window and drives the Windows widget; a Linux container cannot. Docker is
for servers.

**How fresh are the numbers?**
Server: every `ACCTMGR_POLL_SECONDS` (120 recommended). PC widget: `just widget-poll` minutes (5
recommended). Pages refresh every 15 s; countdowns tick every second.

**Can it poll every 10 seconds?**
Not sensibly: the usage endpoint rate-limits, and a throttled account shows no numbers at all.

**Is a login on one server valid on another?**
No. Each server (and each PC) keeps its own logins; sign in once per place, or let PCs follow one
server with `just remote`.

**Where are tokens stored, and who can see them?**
Only in the account's config folder (PC or server volume). No page, API or log returns them; widget
API tokens are stored as SHA-256 hashes and shown once at creation.

**Is this allowed by Anthropic's terms?**
Logins go through the official Claude Code CLI and usage is only read, as the upstream widget does.
Using subscription tokens to run other tools against Claude is a different matter and not done here.
