// Stop/start claude-code-usage-monitor.exe (port of kit Get-MonitorExe / Stop-Monitor / Start-Monitor).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOCALAPPDATA } from './paths';

const EXE = 'claude-code-usage-monitor.exe';

export function findWidgetExe(): string | null {
	const override = process.env.WIDGET_EXE;
	if (override) return fs.existsSync(override) ? override : null;
	// This fork's build (setup.ps1 installs it here) reads accounts.db; prefer it over the
	// upstream WinGet package, which does not.
	const ours = path.join(LOCALAPPDATA, 'Programs', 'ClaudeUsageMonitor', EXE);
	if (fs.existsSync(ours)) return ours;
	const root = path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
	try {
		for (const d of fs.readdirSync(root)) {
			if (!d.startsWith('CodeZeno.ClaudeCodeUsageMonitor')) continue;
			const p = path.join(root, d, EXE);
			if (fs.existsSync(p)) return p;
		}
	} catch {
		/* no winget packages dir */
	}
	return null;
}

export function widgetRunning(): boolean {
	try {
		// CSV, not the table format: the table truncates image names to 25 chars (drops ".exe").
		const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH'], {
			encoding: 'utf8',
			windowsHide: true
		});
		return out.toLowerCase().includes(`"${EXE}"`);
	} catch {
		return false;
	}
}

export async function restartWidget(): Promise<{ exe: string; wasRunning: boolean }> {
	const exe = findWidgetExe();
	if (!exe) throw new Error('Claude Code Usage Monitor is not installed (or set WIDGET_EXE to its .exe).');
	const wasRunning = widgetRunning();
	if (wasRunning) {
		try {
			execFileSync('taskkill.exe', ['/IM', EXE, '/F'], { stdio: 'ignore', windowsHide: true });
		} catch {
			/* exited meanwhile */
		}
		await new Promise((r) => setTimeout(r, 800));
	}
	const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
	child.unref();
	return { exe, wasRunning };
}
