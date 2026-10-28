import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('$lib/server/db', () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));

const { databaseStatus, schemaStatus, LATEST_MIGRATION } = await import('./health');
const { GET } = await import('../../routes/api/health/+server');

describe('databaseStatus', () => {
	// A block body: vitest runs a function returned from beforeEach as teardown.
	beforeEach(() => {
		execute.mockReset();
	});

	it('is ok when the database answers', async () => {
		execute.mockResolvedValue([{ '?column?': 1 }]);
		expect(await databaseStatus()).toBe('ok');
	});

	// DATABASE_URL unset reaches here only once db/index.ts checks it on use (#311).
	it('is down when the query fails', async () => {
		execute.mockImplementation(() => {
			throw new Error('DATABASE_URL is not set');
		});
		expect(await databaseStatus()).toBe('down');
	});

	// An unreachable host can hold a connect attempt for 30 s. The probe must not.
	it('is down when the database does not answer in time', async () => {
		execute.mockReturnValue(new Promise(() => {}));
		const started = Date.now();
		expect(await databaseStatus(50)).toBe('down');
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

// drizzle's migrator stores each applied migration's journal `when` as created_at,
// a bigint, which postgres.js returns as a string.
describe('schemaStatus', () => {
	beforeEach(() => {
		execute.mockReset();
	});

	it('is current when the newest applied migration is the newest in this build', async () => {
		execute.mockResolvedValue([{ applied: String(LATEST_MIGRATION) }]);
		expect(await schemaStatus()).toBe('current');
	});

	it('is behind when the database lacks the newest migration in this build', async () => {
		execute.mockResolvedValue([{ applied: String(LATEST_MIGRATION - 1) }]);
		expect(await schemaStatus()).toBe('behind');
	});

	it('is behind when no migration has been applied', async () => {
		execute.mockResolvedValue([{ applied: null }]);
		expect(await schemaStatus()).toBe('behind');
	});

	it('is unknown when the query fails', async () => {
		execute.mockRejectedValue(new Error('relation "drizzle.__drizzle_migrations" does not exist'));
		expect(await schemaStatus()).toBe('unknown');
	});
});

describe('GET /api/health', () => {
	beforeEach(() => {
		execute.mockReset();
	});

	it('is 200 when the database answers and has every migration', async () => {
		execute.mockResolvedValue([{ applied: String(LATEST_MIGRATION) }]);
		const res = await GET();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok', schema: 'current' });
	});

	// A db:push database has no drizzle schema, so only the migrations query fails.
	it('is 503 when the database answers but its migrations cannot be read', async () => {
		execute.mockImplementation((query: unknown) =>
			JSON.stringify(query).includes('__drizzle_migrations')
				? Promise.reject(new Error('schema "drizzle" does not exist'))
				: Promise.resolve([{ '?column?': 1 }])
		);
		const res = await GET();
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ database: 'ok', schema: 'unknown' });
	});

	// The 2026-10-28 outage: the database answered, but lacked migration 0006.
	it('is 503 when the database answers but is behind this build', async () => {
		execute.mockResolvedValue([{ applied: String(LATEST_MIGRATION - 1) }]);
		const res = await GET();
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			status: 'degraded',
			database: 'ok',
			schema: 'behind'
		});
	});
});
