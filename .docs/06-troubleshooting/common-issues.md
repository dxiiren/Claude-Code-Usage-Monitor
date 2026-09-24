# Common issues

## Login

### "The Claude Code login already stopped: Login successful"
Old kits opened the sign-in link whose localhost callback finished the login before you pasted.
`git pull`, `just manager-build`, then **Re-login** the account (its login already worked).

### "Login failed: Request failed with status code 400"
The code was mistyped or expired (single use, short-lived). **Re-login** and paste straight away.

### Two accounts show the same email
A browser already signed in connected the wrong account. **Re-login** the wrong one — the page's
sign-in window is always a fresh Edge profile.

### Codex: "That address belongs to a different or older sign-in"
The pasted `localhost:1455` address came from an earlier sign-in (each Start makes a new one). Use
the current link, sign in again, paste the new address.

### Codex: the sign-in never finishes / port 1455 busy
Only one Codex sign-in can wait at a time (the CLI's callback server uses port 1455); starting one
cancels the previous. A `codex login` you ran yourself in a terminal holds the same port; close it.

### An account shows "Expired — log in again"
The widget or server got 401/403 or an expired token it could not renew. **Re-login**. Network
errors alone never ask for a re-login.

## Widget

### No numbers / "0% · now"
The widget has not fetched yet or the account has no login. Check the Accounts page status, then
`just restart`. Diagnostics: run the exe with `--diagnose`; log at `%TEMP%\claude-code-usage-monitor.log`.

### Grey box around the card
Fixed: the card theme must not use a `none` background on a floating surface. `just manager-build`
regenerates the theme.

### `just widget-update` reports "SHA-256 mismatch"
Old kits could not load `Get-FileHash` in Windows PowerShell 5.1 launched from PowerShell 7.
`git pull` — the kit now repairs `PSModulePath` and hashes with .NET.

## Server

### "Forbidden host" / 403 on every page
Open the exact `ACCTMGR_PUBLIC_ORIGIN` address (scheme + host + port); IPs and other names are
refused. Behind Cloudflare, make sure the tunnel passes the public hostname as `Host`.

### ERR_SSL_PROTOCOL_ERROR
You used `https://` on a plain-HTTP deployment (or the reverse). Use the TLS overlay for HTTPS.

### "Too many attempts" at sign-in
5 failures per 15 minutes per client; wait for the `Retry-After` time.

### Page 500s after running tests locally
Only with very old kits, where e2e rebuilt the live `web/build/`. `just manager-build`.

## Tests / CI

### A test fails only on CI
Known timing-sensitive spots are already widened (login e2e 20 s, grok shim test 30 s). Re-run the
job once; if it repeats, reproduce with `just test`.
