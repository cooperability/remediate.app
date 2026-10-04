import { describe, expect, it } from 'vitest';
import { band, percent, reopens } from './format';

const now = new Date('2026-09-24T12:00:00Z');
const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe('reopens', () => {
	it.each([
		[-5_000, 'now'],
		[20_000, 'now'],
		[60_000, 'in 1 min'],
		[8 * 60_000, 'in 8 min'],
		[3 * 3_600_000, 'in 3 h'],
		[26 * 3_600_000, 'tomorrow'],
		[4 * 86_400_000, 'in 4 days']
	])('%i ms → %s', (ms, text) => {
		expect(reopens(plus(ms), now)).toBe(text);
	});
	it('reads a bad date as now', () => {
		expect(reopens('not a date', now)).toBe('now');
	});
});

describe('percent and band', () => {
	it('formats', () => {
		expect(percent(0.876)).toBe('88%');
		expect(percent(null)).toBe('–');
	});
	it('buckets strength', () => {
		expect([null, 0.2, 0.5, 0.8, 0.95].map(band)).toEqual([0, 1, 2, 3, 4]);
	});
});
