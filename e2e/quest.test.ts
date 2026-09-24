// Quest in a real browser against a real database: the graph is derived on the
// first visit, a locked door is opened by recalling its card, and the map shows
// the new ground. Signs in as e2e/study.test.ts does: a session row plus its cookie.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
// Its own address: user.email is unique and the files run in parallel.
const EMAIL = 'e2e-quest@test.invalid';
const USER_ID = 'e2e-quest-user';
const TABLES = [
	'review_log',
	'review_state',
	'quest_runs',
	'edges',
	'assessments',
	'nodes',
	'session'
];

test.describe('quest', () => {
	test.skip(!url, 'needs DATABASE_URL');

	const sql = url ? postgres(url, { onnotice: () => {} }) : null!;
	const token = randomBytes(18).toString('base64url');

	async function cleanup() {
		for (const t of TABLES) await sql`delete from ${sql(t)} where user_id = ${USER_ID}`;
		await sql`delete from "user" where id = ${USER_ID}`;
	}

	test.beforeAll(async () => {
		await cleanup();
		await sql`insert into "user" (id, email) values (${USER_ID}, ${EMAIL})`;
		const id = createHash('sha256').update(token).digest('hex');
		await sql`insert into session (id, user_id, expires_at) values (${id}, ${USER_ID}, now() + interval '1 day')`;
		// Written straight to the table, as the seed script does: /quest must derive
		// the halls and passages itself, without an import having run.
		const cards = [
			['q1', 'What does FSRS stand for?', 'Free Spaced Repetition Scheduler', ['memory']],
			['q2', 'Who proposed the forgetting curve?', 'Ebbinghaus', ['memory', 'history']],
			['q3', 'Capital of France?', 'Paris', ['geography']]
		] as const;
		for (const [id, front, back, tags] of cards) {
			await sql`insert into nodes (id, user_id, deck, front, back, tags)
				values (${`${USER_ID}-${id}`}, ${USER_ID}, 'E2E Deck', ${front}, ${back}, ${tags as unknown as string[]})`;
		}
	});

	test.afterAll(async () => {
		await cleanup();
		await sql.end();
	});

	async function signIn(page: Page, baseURL: string) {
		await page.context().addCookies([{ name: 'auth-session', value: token, url: baseURL }]);
	}

	test('a locked door opens because the card was recalled', async ({ page, baseURL }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await signIn(page, baseURL!);

		await page.goto('/quest');
		await expect(page.getByRole('heading', { name: 'E2E Deck' })).toBeVisible();
		await expect(page.getByText('0 / 3 known')).toBeVisible();
		await expect(page.getByRole('heading', { name: /Locked · 3/ })).toBeVisible();

		// The keyboard shortcut opens the next locked door.
		await page.keyboard.press('n');
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('A new door')).toBeVisible();
		await expect(dialog.getByRole('button', { name: /Show answer/ })).toBeVisible();

		await page.keyboard.press('Space');
		await expect(dialog.getByRole('button', { name: /Good/ })).toBeEnabled();
		const [graded] = await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/review/grade')),
			page.keyboard.press('3')
		]);
		expect(await graded.json()).toMatchObject({ rating: 3, unlocked: true });
		await expect(dialog.getByText('The door opens.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Step inside' }).click();
		await expect(dialog).toBeHidden();

		// Inside the card's room; the recall counts, and its tags are found.
		await expect(page.getByText('Recall now')).toBeVisible();
		await expect(page.locator('dl.stats')).toContainText('1/3');

		// The review went through the one write path, tagged as Quest.
		const [log] =
			await sql`select surface, rating, encounter_id from review_log where user_id = ${USER_ID}`;
		expect(log).toMatchObject({ surface: 'quest', rating: 3 });
		expect(log.encounter_id).toBeTruthy();

		// Back through a passage to the hall: one known, two still locked.
		await page.getByRole('button', { name: /E2E Deck/ }).click();
		await expect(page.getByText('1 / 3 known')).toBeVisible();
		await expect(page.getByRole('heading', { name: /Locked · 2/ })).toBeVisible();

		// A reload lands in the same place: position persists server-side (QST-4).
		await page.reload();
		await expect(page.getByRole('heading', { name: 'E2E Deck' })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('a missed door stays shut and says when it reopens', async ({ page, baseURL }) => {
		await signIn(page, baseURL!);
		await page.goto('/quest');
		await page.getByRole('button', { name: /Next ·/ }).click();
		const dialog = page.getByRole('dialog');
		// Space before the dialog is up would press the focused button again.
		await expect(dialog.getByRole('button', { name: /Show answer/ })).toBeVisible();
		await page.keyboard.press('Space');
		await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/review/grade') && r.ok()),
			page.keyboard.press('1')
		]);
		await expect(dialog.getByText('It stays shut, for now.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Back to the room' }).click();
		await expect(page.getByRole('heading', { name: /Sealed · 1/ })).toBeVisible();
		await expect(page.getByText(/Opens in \d+ min/)).toBeVisible();
	});

	test('fits a phone screen (QST-5)', async ({ page, baseURL }) => {
		await signIn(page, baseURL!);
		for (const width of [360, 320]) {
			await page.setViewportSize({ width, height: 740 });
			await page.goto('/quest');
			await expect(page.getByRole('heading', { name: 'E2E Deck' })).toBeVisible();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
			expect(overflow, `/quest at ${width}px`).toBe(0);
			// Thumb-sized targets: every door and map control is at least 44px tall.
			for (const b of await page.locator('button.door, button.map-btn').all()) {
				expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			}
		}
	});
});
