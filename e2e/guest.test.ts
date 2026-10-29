// The signed-out demo: the landing page's button makes a guest holding the two
// AI-made decks, and the real app runs on them. Import and harvest stay closed.
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
const TABLES = [
	'review_log',
	'review_state',
	'quest_runs',
	'harvests',
	'card_trash',
	'jobs',
	'edges',
	'assessments',
	'nodes',
	'session'
];

test.describe('demo guest', () => {
	test.skip(!url, 'needs DATABASE_URL');

	const sql = url ? postgres(url, { onnotice: () => {} }) : null!;

	async function cleanup() {
		const guests = sql`select id from "user" where guest_expires_at is not null`;
		for (const t of TABLES) await sql`delete from ${sql(t)} where user_id in (${guests})`;
		await sql`delete from "user" where guest_expires_at is not null`;
		await sql`delete from guest_throttle`;
	}

	test.beforeAll(cleanup);
	test.afterAll(async () => {
		await cleanup();
		await sql.end();
	});

	test('try the demo, browse, open Quest, and find import and harvest closed', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));

		await page.goto('/');
		await page.getByRole('button', { name: 'Try the demo' }).click();
		await expect(page).toHaveURL('/cards');
		// The session cookie ends with the guest, 24 hours out.
		const cookie = (await page.context().cookies()).find((c) => c.name === 'auth-session')!;
		const hours = (cookie.expires * 1000 - Date.now()) / 3_600_000;
		expect(hours).toBeGreaterThan(23.9);
		expect(hours).toBeLessThanOrEqual(24);
		await expect(page.getByText('Software Knowledge (AI-made)').first()).toBeVisible();
		await expect(
			page.getByText('Personal Finance and Career Growth (AI-made)').first()
		).toBeVisible();
		await expect(page.getByText('Progress is wiped within 24 hours.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Import deck' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Harvest links' })).toHaveCount(0);

		// The import action refuses a guest even when the form is posted by hand.
		const posted = await page.request.post('/cards?/import', {
			headers: { origin: new URL(page.url()).origin },
			multipart: {
				file: { name: 'deck.txt', mimeType: 'text/plain', buffer: Buffer.from('a\tb\n') }
			}
		});
		expect(posted.status()).toBe(403);

		await page.goto('/cards/browse');
		for (const deck of [/Software Knowledge \(AI-made\)/, /Personal Finance .* \(AI-made\)/]) {
			await expect(page.getByRole('link', { name: deck }).first()).toBeVisible();
		}

		// Quest derives the map from the guest's decks and tags.
		await page.goto('/quest');
		await expect(page.getByRole('img', { name: /Map of what you know/ })).toBeVisible();
		await expect(page.getByText('Your map is empty')).toHaveCount(0);

		for (const path of ['/harvest', '/%68arvest']) {
			await page.goto(path);
			await expect(page).toHaveURL('/cards');
		}

		expect(errors).toEqual([]);
	});
});
