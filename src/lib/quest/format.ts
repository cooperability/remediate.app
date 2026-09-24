const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** When a sealed door reopens, relative to now: "now", "in 8 min", "in 3 h", "tomorrow", "in 4 days". */
export function reopens(iso: string, now = new Date()): string {
	const ms = new Date(iso).getTime() - now.getTime();
	if (!Number.isFinite(ms) || ms <= 30_000) return 'now';
	if (ms < HOUR) return `in ${Math.max(1, Math.round(ms / MIN))} min`;
	if (ms < DAY) return `in ${Math.round(ms / HOUR)} h`;
	const days = Math.round(ms / DAY);
	return days <= 1 ? 'tomorrow' : `in ${days} days`;
}

/** 0..1 as a whole percentage, or a dash. */
export const percent = (n: number | null | undefined) =>
	n === null || n === undefined ? '–' : `${Math.round(n * 100)}%`;

/** A strength bucket for colouring: 0 unknown, 1 fading … 4 solid. */
export function band(strength: number | null): 0 | 1 | 2 | 3 | 4 {
	if (strength === null) return 0;
	if (strength >= 0.9) return 4;
	if (strength >= 0.75) return 3;
	if (strength >= 0.5) return 2;
	return 1;
}
