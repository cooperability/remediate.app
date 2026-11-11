import { hasDb } from './testing/db';
import { describe, expect, it } from 'vitest';

const { schemaStatus, LATEST_MIGRATION } = hasDb
	? await import('./health')
	: ({} as typeof import('./health'));

// Runs the real query, so a wrong table name or a misread bigint fails here.
describe.skipIf(!hasDb)('schemaStatus against a migrated database', () => {
	it('is current', async () => {
		expect(await schemaStatus()).toBe('current');
	});

	it('is behind a build that carries one more migration', async () => {
		expect(await schemaStatus(2000, LATEST_MIGRATION + 1)).toBe('behind');
	});
});
