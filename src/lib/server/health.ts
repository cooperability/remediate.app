import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import journal from '../../../drizzle/meta/_journal.json';

/** The `when` of the newest migration this build ships. */
export const LATEST_MIGRATION = Math.max(...journal.entries.map((e) => e.when));

function withTimeout<T>(query: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
	});
	return Promise.race([query, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether the database answers a trivial query. Reports only ok or down: the
 * endpoint is public, so the reason (unset URL, bad host, auth) stays in the logs.
 */
export async function databaseStatus(timeoutMs = 2000): Promise<'ok' | 'down'> {
	try {
		await withTimeout(db.execute(sql`select 1`), timeoutMs);
		return 'ok';
	} catch (e) {
		console.error('[health] database check failed', e);
		return 'down';
	}
}

/**
 * Whether the database has every migration this build ships. Deploys do not run
 * migrations, so code can go live ahead of its schema: on 2026-10-28 /cards
 * failed on a column migration 0006 adds. drizzle's migrator records each
 * applied migration's journal `when` as created_at, and applies in that order.
 */
export async function schemaStatus(
	timeoutMs = 2000,
	latest = LATEST_MIGRATION
): Promise<'current' | 'behind' | 'unknown'> {
	try {
		const [row] = await withTimeout(
			db.execute<{ applied: string | null }>(
				sql`select max(created_at) as applied from drizzle.__drizzle_migrations`
			),
			timeoutMs
		);
		return Number(row?.applied ?? 0) >= latest ? 'current' : 'behind';
	} catch (e) {
		console.error('[health] schema check failed', e);
		return 'unknown';
	}
}
