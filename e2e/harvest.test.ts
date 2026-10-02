// The BMX harvest page against a real database: backfill articles.csv, review,
// add two links to a new deck, then queue a link that cannot resolve and watch the
// page fetch it into the failed tab. No test here reaches the internet.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
const EMAIL = 'e2e-harvest@test.invalid';
const USER_ID = 'e2e-harvest-user';

test.describe('harvest', () => {
	test.skip(!url, 'needs DATABASE_URL');
	test.describe.configure({ mode: 'serial' });

	const sql = url ? postgres(url, { onnotice: () => {} }) : null!;
	const token = randomBytes(18).toString('base64url');

	async function cleanup() {
		for (const t of ['harvests', 'review_log', 'review_state', 'assessments', 'nodes', 'session'])
			await sql`delete from ${sql(t)} where user_id = ${USER_ID}`;
		await sql`delete from "user" where id = ${USER_ID}`;
	}
	test.beforeAll(async () => {
		await cleanup();
		await sql`insert into "user" (id, email) values (${USER_ID}, ${EMAIL})`;
		const id = createHash('sha256').update(token).digest('hex');
		await sql`insert into session (id, user_id, expires_at) values (${id}, ${USER_ID}, now() + interval '1 day')`;
	});
	test.afterAll(async () => {
		await cleanup();
		await sql.end();
	});
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
	});

	test('backfill articles.csv and add links to a deck', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/cards');
		await page.getByRole('link', { name: /Harvest links/ }).click();
		await expect(page.getByRole('heading', { name: 'Harvest links' })).toBeVisible();

		await page.setInputFiles('#csv', 'source_data/articles.csv');
		await page.getByRole('button', { name: 'Import CSV' }).click();
		await expect(page.getByText(/^Added \d+ of 3861 rows/)).toBeVisible({ timeout: 20_000 });
		const tab = page.getByRole('link', { name: /To review/ });
		await expect(tab).toHaveAttribute('aria-current', 'page');

		const boxes = page.getByRole('checkbox', { name: /^Select (?!all)/ });
		await expect(boxes).toHaveCount(25);
		await boxes.nth(0).check();
		await boxes.nth(1).check();
		await expect(page.getByText('2 selected')).toBeVisible();
		await page.getByPlaceholder('Reading').fill('Reading list');
		await page.getByPlaceholder('web infosec').fill('news');
		await page.getByRole('button', { name: 'Add to deck' }).click();
		await expect(page.getByText('Added 2 cards to Reading list.')).toBeVisible();
		await expect(page.getByRole('link', { name: /Added\s*2/ })).toBeVisible();

		await page.goto('/cards');
		await expect(page.getByRole('heading', { name: 'Reading list' })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('a queued link that cannot resolve lands in failed with its reason', async ({ page }) => {
		await page.goto('/harvest');
		await page
			.getByRole('textbox', { name: 'Links', exact: true })
			.fill('See https://nothing.invalid/story?utm_source=x for more.');
		await page.getByRole('button', { name: 'Queue links' }).click();
		await expect(page.getByText('Queued 1 link.')).toBeVisible();
		// The page fetches the queue on its own after queueing.
		await expect(page.getByRole('link', { name: /Failed\s*1/ })).toBeVisible({ timeout: 20_000 });
		await page.getByRole('link', { name: /Failed/ }).click();
		await expect(page.getByText('https://nothing.invalid/story')).toBeVisible();
		await expect(page.getByText(/network error/)).toBeVisible();
	});
});
