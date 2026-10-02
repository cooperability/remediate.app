// The study loop in a real browser against a real database: import, grade,
// reload mid-round, relearn, finish, next round. Skips without DATABASE_URL.
//
// Logging in by email needs the dev console, so the test writes a session row
// directly, in the shape auth.createSession writes, and sets its cookie. The
// web server must list E2E_EMAIL in ALLOWED_EMAILS (playwright.config.ts).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
const E2E_EMAIL = 'e2e@test.invalid';
const USER_ID = 'e2e-user';
const TABLES = ['review_log', 'review_state', 'assessments', 'nodes', 'session'];

test.describe('study round', () => {
	test.skip(!url, 'needs DATABASE_URL');

	const sql = url ? postgres(url, { onnotice: () => {} }) : null!;
	const token = randomBytes(18).toString('base64url');

	async function cleanup() {
		for (const t of TABLES) await sql`delete from ${sql(t)} where user_id = ${USER_ID}`;
		await sql`delete from "user" where id = ${USER_ID}`;
	}

	test.beforeAll(async () => {
		await cleanup();
		await sql`insert into "user" (id, email) values (${USER_ID}, ${E2E_EMAIL})`;
		const id = createHash('sha256').update(token).digest('hex');
		await sql`insert into session (id, user_id, expires_at) values (${id}, ${USER_ID}, now() + interval '1 day')`;
	});

	test.afterAll(async () => {
		await cleanup();
		await sql.end();
	});

	/** Flip, rate, and wait for the server to store the grade. */
	async function grade(page: Page, key: string) {
		// Keys are ignored while the previous grade is in flight, so wait for each state.
		await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible();
		await page.keyboard.press('Space');
		await expect(page.getByRole('button', { name: /Good/ })).toBeEnabled();
		await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/review/grade') && r.ok()),
			page.keyboard.press(key)
		]);
	}

	test('import, grade, reload, relearn, finish, next round', async ({ page, context, baseURL }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);

		await page.goto('/cards');
		await page.setInputFiles(
			'input[type=file]',
			'source_data/CompSci (AIML_Web3_Math_Logic_Tech).txt'
		);
		await page.getByRole('button', { name: 'Import deck' }).click();
		await expect(page.getByText('Imported 137 cards.')).toBeVisible();

		await page.getByRole('link', { name: 'Study' }).first().click();
		const counter = page.locator('header .font-mono').first();
		await expect(counter).toHaveText('0 / 20');

		// Anki cards use <code> for literal code. The typography plugin's decorative
		// backticks around it read as part of the answer.
		const tick = await page
			.locator('.card-html')
			.first()
			.evaluate((el) => {
				const code = el.appendChild(document.createElement('code'));
				const content = getComputedStyle(code, '::before').content;
				code.remove();
				return content;
			});
		expect(tick).toBe('none');

		await grade(page, '1'); // Again: owed one relearning repeat
		await grade(page, '3');
		await expect(counter).toHaveText('2 / 20');

		// A reload resumes the same round rather than opening a new one.
		await page.reload();
		await expect(counter).toHaveText('2 / 20');

		// A keyboard user who tabs to a rating and presses Enter gets that rating: the
		// window shortcut must not swallow Enter as a flip.
		await page.keyboard.press('Space');
		await page.getByRole('button', { name: /Good/ }).focus();
		await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/review/grade') && r.ok()),
			page.keyboard.press('Enter')
		]);
		await expect(counter).toHaveText('3 / 20');

		// 17 more untried cards, then the missed one comes back marked as relearning.
		for (let i = 0; i < 17; i++) await grade(page, '3');
		await expect(counter).toHaveText('20 / 20');
		await expect(page.getByText('relearning')).toBeVisible();
		await grade(page, '3');

		// First attempts only: 19 of 20 recalled.
		await expect(page.getByText('Round score')).toBeVisible();
		await expect(page.getByText('95%').first()).toBeVisible();

		await page.getByRole('button', { name: 'Next round' }).click();
		await expect(counter).toHaveText('0 / 20');
		expect(errors).toEqual([]);
	});

	// Runs after the round above, so the dashboard has a deck to show.
	test('signed-in pages fit a phone screen', async ({ page, context, baseURL }) => {
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

		// 320 is the WCAG reflow width.
		for (const width of [375, 320]) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/cards');
			await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
			expect(await overflow(), `/cards at ${width}px`).toBe(0);
			// A squeezed row wraps Log out instead of overflowing, so check the items too.
			const button = (await page.getByRole('button', { name: 'Log out' }).boundingBox())!;
			const toggle = (await page.getByRole('group', { name: 'Theme' }).boundingBox())!;
			expect(button.height, `Log out on one line at ${width}px`).toBeLessThan(48);
			expect(toggle.x + toggle.width, `toggle inside the gutter at ${width}px`).toBeLessThanOrEqual(
				width - 16
			);

			await page.getByRole('link', { name: 'Details' }).first().click();
			await page.waitForURL(/\/cards\/deck/);
			expect(await overflow(), `deck page at ${width}px`).toBe(0);
		}
	});

	// Runs last among the signed-in tests: it removes the deck the others use.
	test('deletes a deck after confirmation', async ({ page, context, baseURL }) => {
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		await page.goto('/cards');
		await page.getByRole('link', { name: 'Details' }).first().click();
		await page.waitForURL(/\/cards\/deck/);
		await page.getByRole('checkbox', { name: /Delete \d+ cards/ }).check();
		await page.getByRole('button', { name: 'Delete deck' }).click();
		await page.waitForURL(/\/cards\?deleted=/);
		await expect(page.getByRole('status')).toContainText('Deleted');
		await expect(page.getByText('No decks yet')).toBeVisible();
	});

	// Also covers a file chosen before hydration: the server-rendered form must submit.
	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('imports a deck', async ({ page, context, baseURL }) => {
			await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
			await page.goto('/cards');
			await page.setInputFiles(
				'input[type=file]',
				'source_data/CompSci (AIML_Web3_Math_Logic_Tech).txt'
			);
			await page.getByRole('button', { name: 'Import deck' }).click();
			await expect(page.getByText('Imported 137 cards.')).toBeVisible();
		});
	});
});
