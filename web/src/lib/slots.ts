// Time-slot helpers shared by the server (settings, report maths) and the pages. Pure, no imports.

/** One report time slot: minutes of the day, `to` earlier than `from` = runs past midnight. */
export interface Slot {
	name: string;
	from: number;
	to: number;
}

export const MAX_SLOTS = 12;

/** Minutes a slot covers (a slot whose ends meet covers the whole day). */
export const slotLength = (s: Slot) => (s.to - s.from + 1440) % 1440 || 1440;

/** Which problem a slot list has, or null. Overlaps are refused; gaps are allowed. */
export function slotsProblem(slots: Slot[]): string | null {
	if (!Array.isArray(slots) || slots.length < 1) return 'Keep at least one time slot.';
	if (slots.length > MAX_SLOTS) return `Use ${MAX_SLOTS} time slots or fewer.`;
	const cover = new Uint8Array(1440);
	for (const s of slots) {
		if (!s || !Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 0 || s.from > 1439 || s.to < 0 || s.to > 1439)
			return 'Each time slot needs a From and a To time.';
		if (typeof s.name !== 'string' || s.name.length > 20 || /[\u0000-\u001f]/.test(s.name)) return 'Keep slot names to 20 plain characters or fewer.';
		const len = slotLength(s);
		for (let k = 0; k < len; k++) {
			const m = (s.from + k) % 1440;
			if (cover[m]) return 'Two time slots overlap. Change the times so each minute belongs to one slot only.';
			cover[m] = 1;
		}
	}
	return null;
}

/** Minutes of the day that no slot covers. */
export function uncoveredMinutes(slots: Slot[]): number {
	const cover = new Uint8Array(1440);
	for (const s of slots) for (let k = 0, len = slotLength(s); k < len; k++) cover[(s.from + k) % 1440] = 1;
	return cover.reduce((n, v) => n + (v ? 0 : 1), 0);
}

/** "9am", "12:30pm" */
export function clock(minutes: number): string {
	const h = Math.floor(minutes / 60) % 24;
	const m = minutes % 60;
	return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
export const slotRange = (s: Slot): string => `${clock(s.from)} – ${clock(s.to)}`;
export const slotName = (s: Slot): string => s.name.trim() || slotRange(s);

/** "4 h", "1 h 30 min", "45 min" */
export function duration(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}
