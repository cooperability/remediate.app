import { hasDb } from '../testing/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as table from '../db/schema';
import type { HarvestResult } from './harvest';

const { db, asTenant } = hasDb ? await import('../db') : ({} as typeof import('../db'));
const q = hasDb ? await import('./queue') : ({} as typeof import('./queue'));

const result = (over: Partial<HarvestResult>): HarvestResult => ({
	tier: 'metadata',
	title: 'A title long enough to hash',
	description: 'Gist.',
	siteName: 'Site',
	author: null,
	publishedAt: null,
	image: null,
	canonical: null,
	text: '',
	finalUrl: null,
	failReason: null,
	contentHash: null,
	...over
});

describe.skipIf(!hasDb)('harvest queue against the database', () => {
	const run = crypto.randomUUID().slice(0, 8);
	const userId = `test-user-${run}`;
	const as = <T>(fn: () => Promise<T>) => asTenant(userId, fn);

	async function cleanup() {
		await db.delete(table.harvest).where(eq(table.harvest.userId, userId));
		await db.delete(table.node).where(eq(table.node.userId, userId));
		await db.delete(table.user).where(eq(table.user.id, userId));
	}
	beforeEach(async () => {
		await cleanup();
		await db.insert(table.user).values({ id: userId, email: `${userId}@test.invalid` });
	});
	afterAll(cleanup);

	it('queues normalized URLs once', async () => {
		const first = await as(() =>
			q.queueUrls(userId, ['https://a.test/x?utm_source=y', 'https://a.test/x', 'nope'])
		);
		expect(first).toEqual({ queued: 1, already: 0 });
		expect(await as(() => q.queueUrls(userId, ['https://a.test/x#frag']))).toEqual({
			queued: 0,
			already: 1
		});
	});

	it('fetches queued rows into ready and failed, spacing one domain', async () => {
		await as(() =>
			q.queueUrls(userId, ['https://a.test/1', 'https://a.test/2', 'https://b.test/broken'])
		);
		const seen: [string, number][] = [];
		const harvest = async (url: string) => {
			seen.push([url, Date.now()]);
			return url.includes('broken')
				? result({ tier: 'failed', title: null, failReason: 'HTTP 500' })
				: result({ title: `Story at ${url}`, contentHash: url });
		};
		const out = await as(() => q.processQueue(userId, { harvest }));
		expect(out).toEqual({ done: 3, remaining: 0 });
		// Two hits on a.test, at least a second apart.
		const a = seen.filter(([u]) => u.includes('a.test')).map(([, t]) => t);
		expect(a[1] - a[0]).toBeGreaterThanOrEqual(q.SPACING_MS - 20);

		const list = await as(() => q.listHarvests(userId, 'ready'));
		expect(list.count).toMatchObject({ ready: 2, failed: 1, queued: 0 });
		expect(list.items[0].proposal?.title).toBe('Story at https://a.test/1');
		const failed = await as(() => q.listHarvests(userId, 'failed'));
		expect(failed.items[0].failReason).toBe('HTTP 500');
	});

	// Two tabs, or an auto-continue overlapping the last round: each row is fetched once.
	it('never fetches one row in two overlapping rounds', async () => {
		await as(() =>
			q.queueUrls(userId, ['https://a.test/1', 'https://b.test/2', 'https://c.test/3'])
		);
		const seen: string[] = [];
		const harvest = async (url: string) => {
			seen.push(url);
			await new Promise((r) => setTimeout(r, 50));
			return result({ title: `Story at ${url}` });
		};
		const [x, y] = await Promise.all([
			as(() => q.processQueue(userId, { harvest })),
			as(() => q.processQueue(userId, { harvest }))
		]);
		expect(x.done + y.done).toBe(3);
		expect([...seen].sort()).toEqual(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
	});

	it('imports a CSV row holding a NUL byte', async () => {
		const csv = 'url,title,description\nhttps://a.test/n,Ti\u0000tle of a story,Gi\u0000st\n';
		const r = await as(() => q.importArticlesCsv(userId, csv));
		expect(r.added).toBe(1);
		const list = await as(() => q.listHarvests(userId, 'ready'));
		expect(list.items[0].proposal).toMatchObject({
			title: 'Title of a story',
			description: 'Gist'
		});
	});

	it('stops at the time budget and reports what remains', async () => {
		await as(() =>
			q.queueUrls(userId, ['https://a.test/1', 'https://a.test/2', 'https://a.test/3'])
		);
		const out = await as(() =>
			q.processQueue(userId, { budgetMs: 500, harvest: async () => result({}) })
		);
		expect(out).toEqual({ done: 1, remaining: 2 });
	});

	it('backfills articles.csv at the metadata tier and marks cross-domain duplicates', async () => {
		const csv = [
			'id,date,url,title,description,image,author',
			'a,2023-01-01,https://www.wsj.com/articles/usps-trucks?mod=x&utm_source=apple,USPS Is Hiring Trucks to Carry Its Mail — The Wall Street Journal,Desc,,The Wall Street Journal',
			'b,2023-01-02,https://apple.news/AbC,USPS Is Hiring Trucks to Carry Its Mail | WSJ,Desc,,WSJ',
			'c,2023-01-03,notaurl,Bad,,,'
		].join('\n');
		const out = await as(() => q.importArticlesCsv(userId, csv));
		expect(out).toMatchObject({ rows: 3, added: 2, skipped: 1, duplicates: 1 });
		const again = await as(() => q.importArticlesCsv(userId, csv));
		expect(again).toMatchObject({ added: 0, already: 2 });
		const dup = await as(() => q.listHarvests(userId, 'duplicate'));
		expect(dup.items.map((i) => i.domain)).toEqual(['apple.news']);
	});

	// The real 3,861-row file: past vitest's 5 s default on a cold database (seen once in
	// a full run straight after a migrate), so these two get room. The accept test below
	// starts by cleaning those rows up.
	it('imports the real articles.csv', async () => {
		const out = await as(() =>
			q.importArticlesCsv(userId, readFileSync('source_data/articles.csv', 'utf8'))
		);
		expect(out.rows).toBe(3861);
		expect(out.added + out.skipped + out.already).toBeLessThanOrEqual(3861);
		const list = await as(() => q.listHarvests(userId, 'ready'));
		expect(list.count.ready + list.count.duplicate).toBe(out.added);
		expect(list.items).toHaveLength(q.PAGE_SIZE);
	}, 30_000);

	it('accepts ready rows as cards once, and discards and retries', async () => {
		await as(() =>
			q.queueUrls(userId, ['https://a.test/1', 'https://a.test/2', 'https://c.test/x'])
		);
		await as(() =>
			q.processQueue(userId, {
				harvest: async (u) =>
					u.includes('c.test')
						? result({ tier: 'failed', title: null, failReason: 'timed out' })
						: result({ title: `<b>Title</b> ${u}`, description: 'Gist <script>x</script>' })
			})
		);
		const ready = await as(() => q.listHarvests(userId, 'ready'));
		const [one, two] = ready.items.map((i) => i.id);
		expect(await as(() => q.acceptHarvests(userId, [one], 'Reading', ['web']))).toBe(1);
		// Accepting again is a no-op: the row is no longer ready.
		expect(await as(() => q.acceptHarvests(userId, [one], 'Reading', ['web']))).toBe(0);

		const cards = await db.select().from(table.node).where(eq(table.node.userId, userId));
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			deck: 'Reading',
			tags: ['web'],
			kind: 'card',
			url: 'https://a.test/1'
		});
		expect(cards[0].front).toContain('&lt;b&gt;Title&lt;/b&gt;');
		expect(cards[0].back).not.toContain('<script');
		expect(cards[0].back).toContain('href="https://a.test/1"');

		expect(await as(() => q.setStatus(userId, [two], 'discarded', ['ready']))).toBe(1);
		const failed = await as(() => q.listHarvests(userId, 'failed'));
		expect(await as(() => q.setStatus(userId, [failed.items[0].id], 'queued', ['failed']))).toBe(1);
		const after = await as(() => q.listHarvests(userId, 'queued'));
		expect(after.count).toMatchObject({ queued: 1, accepted: 1, discarded: 1, failed: 0 });
		// Junk ids are ignored, not an error.
		expect(await as(() => q.setStatus(userId, ['x', '-1', ''], 'discarded', ['ready']))).toBe(0);
	}, 30_000);
});
