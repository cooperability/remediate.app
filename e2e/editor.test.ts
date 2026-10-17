// The card editor in a real browser against a real database, at a desktop and a
// phone width (ROADMAP CRD-A): create a card, find it by search, edit its back,
// and see the change in Study. Skips without DATABASE_URL.
//
// Signs in through a session row, as study.test.ts does. The web server must list
// E2E_EMAIL in ALLOWED_EMAILS (playwright.config.ts).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
const E2E_EMAIL = 'e2e-editor@test.invalid';
const USER_ID = 'e2e-editor-user';
const TABLES = [
	'card_trash',
	'review_log',
	'review_state',
	'quest_runs',
	'edges',
	'assessments',
	'nodes',
	'session'
];

test.describe('card editor', () => {
	test.skip(!url, 'needs DATABASE_URL');
	test.describe.configure({ mode: 'serial' });

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

	/** Replace a rich field's contents by typing, as a person would. */
	async function typeInto(page: Page, selector: string, text: string) {
		const field = page.locator(selector);
		await field.click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.type(text);
	}

	for (const [width, height] of [
		[1440, 900],
		[390, 844]
	]) {
		test(`create, search, edit and study at ${width}px`, async ({ page, context, baseURL }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.setViewportSize({ width, height });
			await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
			// A deck per width: the second test must not resume the first one's round.
			const deck = `E2E Editor ${width}`;
			const marker = `zq${width}x`;

			await page.goto('/cards/browse?new=1');
			await page.locator('#edit-deck').fill(deck);
			await typeInto(page, '#edit-front', `Capital of France ${marker}?`);
			await typeInto(page, '#edit-back', 'Lyon');
			await page.locator('#edit-tags').fill('geo ');
			await page.getByRole('button', { name: /Add card/ }).click();
			await expect(page.getByText(`Added to ${deck}.`)).toBeVisible();

			if (width < 1024) {
				// The phone editor is a full-screen sheet. Close it to reach the list.
				await page.getByRole('link', { name: 'Close editor' }).click();
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth
				);
				expect(overflow).toBe(0);
			}

			await page.locator('#browse-q').fill(marker);
			const row = page.getByRole('link', { name: new RegExp(marker) });
			await expect(row).toHaveCount(1);
			await row.click();
			await expect(page).toHaveURL(/[?&]card=/);
			await expect(page.locator('#edit-back')).toHaveText('Lyon');
			await typeInto(page, '#edit-back', 'Paris');
			await page.getByRole('button', { name: /^Save/ }).click();
			await expect(page.getByText('Saved.')).toBeVisible();

			if (width >= 1024) {
				// Escape in the account menu closes the menu, not the card beside it, and
				// hands focus back to the button that opened it.
				await page.getByLabel('Account').click();
				await page.getByRole('button', { name: 'Log out' }).focus();
				await page.keyboard.press('Escape');
				await expect(page.getByRole('button', { name: 'Log out' })).toBeHidden();
				await expect(page).toHaveURL(/[?&]card=/);
				await expect(page.getByLabel('Account')).toBeFocused();
			}

			// Ctrl+Delete in a field deletes a word, never the card. A save after it
			// is the barrier: a delete it fired would have been sent first.
			const deletes: string[] = [];
			page.on('request', (r) => {
				if (r.method() === 'POST' && r.url().includes('/delete')) deletes.push(r.url());
			});
			await page.locator('#edit-back').click();
			await page.keyboard.press('End');
			await page.keyboard.press('ControlOrMeta+Delete');
			await Promise.all([
				page.waitForResponse((r) => r.url().includes('/save') && r.request().method() === 'POST'),
				page.keyboard.press('ControlOrMeta+Enter')
			]);
			expect(deletes).toEqual([]);
			await expect(page).toHaveURL(/[?&]card=/);

			await page.goto(`/cards/study?deck=${encodeURIComponent(deck)}`);
			await page.keyboard.press('Space');
			await expect(page.locator('.card-html').filter({ hasText: 'Paris' })).toBeVisible();

			if (width >= 1024) {
				// E opens the current card, and Save comes back to the same round.
				await page.keyboard.press('e');
				await expect(page).toHaveURL(/\/cards\/browse\?card=.*&return=/);
				await typeInto(page, '#edit-back', 'Paris, on the Seine');
				await page.keyboard.press('ControlOrMeta+Enter');
				await expect(page).toHaveURL(/\/cards\/study\?deck=/);
				await page.keyboard.press('Space');
				await expect(page.getByText('Paris, on the Seine')).toBeVisible();
			}

			// kind = 'card': the Quest graph keeps a concept row with the same deck and no tags.
			const [stored] =
				await sql`select tags from nodes where user_id = ${USER_ID} and deck = ${deck} and kind = 'card'`;
			expect(stored.tags).toEqual(['geo']);
			expect(errors).toEqual([]);
		});
	}

	test('side actions keep the filters and the open card', async ({ page, context, baseURL }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const deck = 'E2E Editor actions';
		const [a, b] = ['e2e-editor-a', 'e2e-editor-b'];
		await sql`insert into nodes (id, user_id, deck, front, back) values
			(${a}, ${USER_ID}, ${deck}, 'alpha front', 'alpha back'),
			(${b}, ${USER_ID}, ${deck}, 'beta front', 'beta back')`;
		const dialogs: string[] = [];
		page.on('dialog', (d) => {
			dialogs.push(d.message());
			void d.dismiss();
		});
		const start = `/cards/browse?deck=${encodeURIComponent(deck)}&sort=created&card=${a}`;
		const here = () => new URL(page.url()).pathname + new URL(page.url()).search;
		await page.goto(start);
		const bulk = page.getByRole('region', { name: 'Bulk actions' });

		// Each filter shows its whole label beside the open editor.
		const clipped = await page.locator('#browse-q').evaluate((q) =>
			[...q.form!.querySelectorAll('select')].flatMap((s) => {
				const css = getComputedStyle(s);
				const ctx = document.createElement('canvas').getContext('2d')!;
				ctx.font = css.font;
				const room = s.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
				const label = s.selectedOptions[0].text;
				return ctx.measureText(label).width > room ? [label] : [];
			})
		);
		expect(clipped).toEqual([]);

		// The editor's shortcuts belong to the editor. In the search box they do nothing.
		const saves: string[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().includes('/save')) saves.push(r.url());
		});
		await page.locator('#browse-q').focus();
		await page.keyboard.press('ControlOrMeta+Enter');
		await page.keyboard.press('Escape');
		await page.waitForLoadState('networkidle');
		expect(saves).toEqual([]);
		expect(here()).toBe(start);

		await page.locator(`[data-row="${b}"] input[type=checkbox]`).check();
		await bulk.getByRole('button', { name: 'Suspend', exact: true }).click();
		await expect(page.getByText('Suspended 1 card.')).toBeVisible();
		expect(here()).toBe(start);

		// Ctrl+J with unsaved text: no discard prompt, and the text is still there.
		await typeInto(page, '#edit-back', 'unsaved words');
		await page.keyboard.press('ControlOrMeta+j');
		await expect(page.getByRole('heading', { name: /Edit card\s+suspended/ })).toBeVisible();
		await expect(page.locator('#edit-back')).toHaveText('unsaved words');
		await page.getByRole('button', { name: 'Revert' }).click();

		await page.getByTitle('Flag').click();
		await page.getByRole('button', { name: 'Purple' }).click();
		await expect(page.locator(`summary[aria-label="Flag: Purple"]`)).toBeVisible();
		expect(here()).toBe(start);

		await page.locator(`[data-row="${b}"] input[type=checkbox]`).check();
		await bulk.getByRole('button', { name: 'Delete', exact: true }).click();
		await bulk.getByRole('button', { name: 'Delete 1 card' }).click();
		await expect(page.locator(`[data-row="${b}"]`)).toHaveCount(0);
		// A double click is one Undo. The second must not report the spent trash as a failure.
		await page.getByRole('button', { name: 'Undo', exact: true }).dblclick();
		await expect(page.getByText('Restored 1 card.')).toBeVisible();
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('status').filter({ hasText: 'Restored 1 card.' })).toBeVisible();
		await expect(page.locator(`[data-row="${b}"]`)).toHaveCount(1);
		expect(here()).toBe(start);
		expect(dialogs).toEqual([]);

		// A checkbox takes no text, so Escape from a ticked row still closes the card.
		await page.locator(`[data-row="${a}"] input[type=checkbox]`).check();
		await page.keyboard.press('Escape');
		await expect(page).not.toHaveURL(/card=/);

		const rows =
			await sql`select id, flag, suspended from nodes where id in ${sql([a, b])} order by id`;
		expect(rows).toEqual([
			{ id: a, flag: 7, suspended: true },
			{ id: b, flag: 0, suspended: true }
		]);
	});

	test('a double Ctrl+Enter adds one card, with the tag still being typed', async ({
		page,
		context,
		baseURL
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const deck = 'E2E Editor twice';
		await page.goto('/cards/browse?new=1');
		await page.locator('#edit-deck').fill(deck);
		await typeInto(page, '#edit-front', 'pressed twice');
		const saves: string[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().includes('/save')) saves.push(r.url());
		});
		await page.locator('#edit-tags').fill('halfway');
		await page.keyboard.press('ControlOrMeta+Enter');
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.getByText(`Added to ${deck}.`)).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(saves).toHaveLength(1);
		const rows =
			await sql`select tags from nodes where user_id = ${USER_ID} and deck = ${deck} and kind = 'card'`;
		expect(rows).toEqual([{ tags: ['halfway'] }]);
	});

	test('keyboard shortcuts, and pasted or typed HTML is sanitized', async ({
		page,
		context,
		baseURL
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const dialogs: string[] = [];
		page.on('dialog', (d) => {
			dialogs.push(d.message());
			void d.dismiss();
		});
		const deck = 'E2E Editor keys';
		const [k1, k2, k3] = ['e2e-keys-1', 'e2e-keys-2', 'e2e-keys-3'];
		// Newest first under sort=created: k3, k2, k1.
		await sql`insert into nodes (id, user_id, deck, front, back, created_at) values
			(${k1}, ${USER_ID}, ${deck}, 'one', 'b', now() - interval '3 minutes'),
			(${k2}, ${USER_ID}, ${deck}, 'two', 'b', now() - interval '2 minutes'),
			(${k3}, ${USER_ID}, ${deck}, 'three', 'b', now() - interval '1 minute')`;
		await page.goto(`/cards/browse?deck=${encodeURIComponent(deck)}&sort=created`);
		// Keys reach the page's handlers once it has hydrated.
		await page.waitForLoadState('networkidle');

		await page.keyboard.press('/');
		await expect(page.locator('#browse-q')).toBeFocused();
		await page.locator('#browse-q').blur();

		await page.keyboard.press('j');
		await expect(page).toHaveURL(new RegExp(`card=${k3}`));
		await page.keyboard.press('j');
		await expect(page).toHaveURL(new RegExp(`card=${k2}`));
		await page.keyboard.press('k');
		await expect(page).toHaveURL(new RegExp(`card=${k3}`));

		const preview = page.getByRole('tab', { name: /Preview/ });
		await page.keyboard.press('ControlOrMeta+Shift+p');
		await expect(preview).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('ControlOrMeta+Shift+p');
		await expect(preview).toHaveAttribute('aria-selected', 'false');

		await page.keyboard.press('Escape');
		await expect(page).not.toHaveURL(/card=/);
		await page.keyboard.press('n');
		await expect(page).toHaveURL(/new=1/);
		await expect(page.getByRole('heading', { name: 'New card' })).toBeVisible();

		// Paste goes through the card sanitizer before it reaches the field.
		const front = page.locator('div#edit-front');
		await front.click();
		await front.evaluate((el) => {
			const data = new DataTransfer();
			data.setData('text/html', '<b>bold</b><img src="https://a.test/x.png" onerror="alert(1)">');
			data.setData('text/plain', 'bold');
			el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
		});
		await expect(front.locator('b')).toHaveText('bold');
		expect(await front.innerHTML()).not.toMatch(/onerror/);

		// Ctrl+Shift+X shows the HTML source, and leaving it sanitizes what was typed there.
		await page.keyboard.press('ControlOrMeta+Shift+x');
		const source = page.locator('textarea#edit-front');
		await expect(source).toHaveValue(/<b>bold<\/b>/);
		await source.fill('<i>it</i><img src="https://a.test/y.png" onerror="alert(2)">');
		await source.press('ControlOrMeta+Shift+x');
		await expect(front.locator('i')).toHaveText('it');
		expect(await front.innerHTML()).not.toMatch(/onerror/);
		expect(dialogs).toEqual([]);
	});

	test('the format bar and the tag completer, through to what is stored', async ({
		page,
		context,
		baseURL
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		// Escape that reached the card would ask about the unsaved changes.
		const dialogs: string[] = [];
		page.on('dialog', (d) => {
			dialogs.push(d.message());
			void d.dismiss();
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const deck = 'E2E Editor format';
		// The completer offers the user's own tags.
		await sql`insert into nodes (id, user_id, deck, front, back, tags) values
			('e2e-format-seed', ${USER_ID}, ${deck}, 'seed', 'b', ${['Biology::Cells', 'chem', 'cellar', 'Accelerate']})`;
		await page.goto(`/cards/browse?new=1&deck=${encodeURIComponent(deck)}`);
		await page.waitForLoadState('networkidle');
		const bar = page.getByRole('toolbar', { name: 'Formatting' });
		const tool = (name: string) => bar.getByRole('button', { name, exact: true });
		const front = page.locator('div#edit-front');
		const back = page.locator('div#edit-back');

		// Nothing to format until a field has focus.
		await expect(tool('Bold (Ctrl+B)')).toBeDisabled();
		await typeInto(page, '#edit-front', 'alpha');
		await page.keyboard.press('ControlOrMeta+a');
		await tool('Highlight').click();
		await expect(front.locator('mark')).toHaveText('alpha');
		await expect(tool('Highlight')).toHaveAttribute('aria-pressed', 'true');
		// Pressed again inside the highlight, it takes it off.
		await tool('Highlight').click();
		await expect(front.locator('mark')).toHaveCount(0);
		// Taking it off is on the undo stack too, and undo restores the text once.
		await tool('Undo edit (Ctrl+Z)').click();
		await expect(front.locator('mark')).toHaveText('alpha');
		await expect(front).toHaveText('alpha');
		await page.keyboard.press('ControlOrMeta+a');
		await tool('Strikethrough').click();
		await expect(front.locator('strike, s')).toHaveText('alpha');
		// Phones have no Ctrl+Z, so the bar carries undo and redo.
		await tool('Undo edit (Ctrl+Z)').click();
		await expect(front.locator('strike, s')).toHaveCount(0);
		await tool('Redo edit (Ctrl+Shift+Z)').click();
		await expect(front.locator('strike, s')).toHaveText('alpha');

		// Tab from a field leads away from the bar, so Alt+F10 takes the keyboard into it.
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('Alt+F10');
		await expect(page.getByRole('button', { name: 'Text styles and indent' })).toBeFocused();
		// A toolbar is one Tab stop. Arrows, Home and End move inside it, and the ends wrap.
		await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
		await page.keyboard.press('End');
		await expect(tool('Clear formatting')).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('button', { name: 'Text styles and indent' })).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(tool('Bold (Ctrl+B)')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(front.locator('b, strong')).toHaveText('alpha');
		await expect(front).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(front.locator('b, strong')).toHaveCount(0);

		// Text styles, and Escape closes their menu, not the card.
		await page.getByRole('button', { name: 'Text styles and indent' }).click();
		await page.getByRole('button', { name: 'Heading', exact: true }).click();
		await expect(front.locator('h3')).toHaveText('alpha');
		await page.getByRole('button', { name: 'Text styles and indent' }).click();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('group', { name: 'Text styles' })).toHaveCount(0);
		await expect(page).toHaveURL(/new=1/);

		// Three kinds of list, switched in place, and Tab nests inside one.
		await typeInto(page, '#edit-back', 'one');
		await tool('Bulleted list').click();
		await expect(back.locator('ul:not(.dashed) > li')).toHaveText('one');
		await tool('Dashed list').click();
		await expect(back.locator('ul.dashed > li')).toHaveText('one');
		await expect(tool('Dashed list')).toHaveAttribute('aria-pressed', 'true');
		await tool('Numbered list').click();
		await expect(back.locator('ol > li')).toHaveText('one');
		await tool('Dashed list').click();
		await expect(back.locator('ul.dashed > li')).toHaveText('one');
		await page.keyboard.press('Enter');
		await page.keyboard.type('two');
		await page.keyboard.press('Tab');
		await expect(back.locator('ul ul, li ul')).toHaveCount(1);
		await expect(back).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(back.locator('ul ul, li ul')).toHaveCount(0);
		// A top-level item does not un-nest further: Shift+Tab leaves the field, so a list never traps the keyboard.
		await page.keyboard.press('Shift+Tab');
		await expect(back).not.toBeFocused();
		await expect(back.locator('ul.dashed > li')).toHaveText(['one', 'two']);
		// Inline code across two items would run their lines together, so it does nothing.
		await back.click();
		await page.keyboard.press('ControlOrMeta+a');
		await tool('Inline code').click();
		await expect(back.locator('code')).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+End');

		// A bare address gets https, and the link box offers Remove once inside a link.
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await page.keyboard.type('see docs');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('ControlOrMeta+k');
		const address = page.getByLabel('Link address');
		await expect(address).toBeFocused();
		await address.fill('example.com');
		await address.press('Enter');
		await expect(back.locator('a[href="https://example.com"]')).toHaveText('docs');
		await expect(back).toBeFocused();
		// Collapsing the selection leaves the caret just before the link. One step in, it is inside.
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ControlOrMeta+k');
		await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
		await address.press('Escape');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+k');
		await expect(address).toHaveValue('https://example.com');
		await page.getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(back.locator('a')).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+k');
		await address.fill('javascript:alert(1)');
		await expect(page.getByRole('button', { name: 'Add link' })).toBeDisabled();
		// A port is no scheme: a bare host with one gets https.
		await address.fill('localhost:5173');
		await expect(page.getByRole('button', { name: 'Add link' })).toBeEnabled();
		await address.press('Escape');
		await expect(page).toHaveURL(/new=1/);
		await expect(back).toBeFocused();
		// The link box belongs to the field it opened from: moving to the other one closes it.
		await page.keyboard.press('ControlOrMeta+k');
		await expect(address).toBeVisible();
		await front.click();
		await expect(address).toHaveCount(0);

		// The completer ranks a prefix, then a `::` part, then a substring. Arrows pick,
		// and a typed case adopts the stored one.
		const tags = page.locator('#edit-tags');
		await tags.click();
		await expect(bar).toBeVisible();
		await expect(tool('Bold (Ctrl+B)')).toBeDisabled();
		await tags.pressSequentially('cel');
		await expect(page.locator('#edit-tags-list').getByRole('option')).toHaveText([
			'cellar',
			'Biology::Cells',
			'Accelerate'
		]);
		await tags.press('ArrowDown');
		await tags.press('ArrowDown');
		await tags.press('Enter');
		await tags.pressSequentially('CHEM ');
		const chips = page.getByRole('button', { name: /^Edit tag / });
		await expect(chips).toHaveText(['Biology::Cells', 'chem']);
		// Tapping a chip takes it back into the box.
		await chips.filter({ hasText: 'chem' }).click();
		await expect(tags).toHaveValue('chem');
		await expect(tags).toBeFocused();
		await tags.press('Enter');

		// A half-typed address left in the link box is no URL the form checks, so the card saves.
		await back.click();
		await page.keyboard.press('ControlOrMeta+k');
		await address.fill('example.com');
		await back.click();
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.getByText(`Added to ${deck}.`)).toBeVisible();
		const [stored] =
			await sql`select front, back, tags from nodes where user_id = ${USER_ID} and kind = 'card' and deck = ${deck} and id <> 'e2e-format-seed'`;
		expect(stored.front).toMatch(/<h3>.*<(strike|s)>.*alpha/);
		expect(stored.front).toContain('<mark>');
		expect(stored.back).toContain('<ul class="dashed">');
		expect(stored.tags).toEqual(['Biology::Cells', 'chem']);

		// Ctrl+Enter inside the link box saves the card too.
		await typeInto(page, '#edit-front', 'second');
		await page.keyboard.press('ControlOrMeta+k');
		await address.fill('example.com');
		await address.press('ControlOrMeta+Enter');
		// A saved new card clears the editor for the next one.
		await expect(front).toHaveText('');
		const [{ n }] =
			await sql`select count(*)::int as n from nodes where user_id = ${USER_ID} and kind = 'card' and deck = ${deck}`;
		expect(n).toBe(3);
		expect(dialogs).toEqual([]);
		expect(errors).toEqual([]);
	});

	test('the other text styles, shortcuts, link kinds and completer keys', async ({
		page,
		context,
		baseURL
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const dialogs: string[] = [];
		page.on('dialog', (d) => {
			dialogs.push(d.message());
			void d.dismiss();
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		await sql`insert into nodes (id, user_id, deck, front, back, tags) values
			('e2e-keys-seed', ${USER_ID}, 'E2E Editor more', 'seed', 'b', ${['qxone', 'qxtwo', 'qyak']})`;
		await page.goto('/cards/browse?new=1');
		await page.waitForLoadState('networkidle');
		const bar = page.getByRole('toolbar', { name: 'Formatting' });
		const tool = (name: string) => bar.getByRole('button', { name, exact: true });
		const styles = page.getByRole('button', { name: 'Text styles and indent' });
		const style = (name: string) =>
			page.getByRole('group', { name: 'Text styles' }).getByRole('button', { name, exact: true });
		const front = page.locator('div#edit-front');
		const back = page.locator('div#edit-back');

		await typeInto(page, '#edit-front', 'line');
		await styles.click();
		await style('Subheading').click();
		await expect(front.locator('h4')).toHaveText('line');
		await styles.click();
		await style('Monospaced').click();
		await expect(front.locator('pre')).toHaveText('line');
		await styles.click();
		await style('Body').click();
		await expect(front.locator('h4, pre')).toHaveCount(0);
		await expect(front).toHaveText('line');

		// Escape inside the bar closes its menu and hands the keyboard back to the field. It
		// never reaches the card.
		await page.keyboard.press('Alt+F10');
		await page.keyboard.press('Enter');
		// Opened from the keyboard, the menu takes focus, so Tab need not go back past it.
		await expect(page.getByRole('group', { name: 'Text styles' })).toBeVisible();
		await expect(styles).toHaveAttribute('aria-controls', 'format-styles');
		await expect(style('Heading')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('group', { name: 'Text styles' })).toHaveCount(0);
		await expect(front).toBeFocused();
		await expect(page).toHaveURL(/new=1/);

		// The menu's Indent and Outdent, for a phone with no Tab key.
		await tool('Bulleted list').click();
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.type('sub');
		await styles.click();
		await style('Indent ⇥').click();
		await expect(front.locator('li ul, ul ul')).toHaveCount(1);
		await style('⇤ Outdent').click();
		await expect(front.locator('li ul, ul ul')).toHaveCount(0);
		await page.keyboard.press('Escape');

		// Anki's subscript and superscript keys.
		await page.keyboard.press('Shift+Home');
		await page.keyboard.press('ControlOrMeta+Equal');
		await expect(front.locator('sub')).toHaveText('sub');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(front.locator('sub')).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+Shift+Equal');
		await expect(front.locator('sup')).toHaveText('sub');
		await tool('Clear formatting').click();
		await expect(front.locator('sup')).toHaveCount(0);

		// An item after a sublist can nest too: Chrome writes the sublist as the item's sibling.
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.type('two');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Enter');
		await page.keyboard.type('three');
		await page.keyboard.press('Shift+Tab');
		await expect(front.locator('ul ul li, li ul li')).toHaveText(['two']);
		await page.keyboard.press('Tab');
		await expect(front).toBeFocused();
		await expect(front.locator('ul ul li, li ul li')).toHaveText(['two', 'three']);

		// A bare address at a caret goes in as a mail link, its text the address.
		await back.click();
		await page.keyboard.press('ControlOrMeta+k');
		const address = page.getByLabel('Link address');
		await address.fill('name@example.com');
		await address.press('Enter');
		await expect(back.locator('a[href="mailto:name@example.com"]')).toHaveText('name@example.com');
		// A typed mailto keeps its one scheme, even when the address starts with a digit.
		await page.keyboard.press('Enter');
		await page.keyboard.press('ControlOrMeta+k');
		await address.fill('mailto:2fa@x.io');
		await address.press('Enter');
		await expect(back.locator('a[href="mailto:2fa@x.io"]')).toHaveText('2fa@x.io');
		// Inside a link the box updates its address and keeps its text.
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ControlOrMeta+k');
		await expect(address).toHaveValue('mailto:2fa@x.io');
		await address.fill('example.org');
		await page.getByRole('button', { name: 'Update', exact: true }).click();
		await expect(back.locator('a[href="https://example.org"]')).toHaveText('2fa@x.io');
		await expect(back.locator('a[href="mailto:2fa@x.io"]')).toHaveCount(0);

		// Focus follows the HTML source toggle both ways, so the bar keeps its field.
		await page.keyboard.press('ControlOrMeta+Shift+x');
		await expect(page.locator('textarea#edit-back')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+Shift+x');
		await expect(back).toBeFocused();

		// ArrowUp from no pick wraps to the last match. Tab and Space take the pick, and
		// Escape closes the list, not the card.
		const tags = page.locator('#edit-tags');
		const options = page.locator('#edit-tags-list').getByRole('option');
		await tags.click();
		await tags.pressSequentially('qx');
		await expect(options).toHaveText(['qxone', 'qxtwo']);
		await tags.press('ArrowUp');
		await expect(options.filter({ hasText: 'qxtwo' })).toHaveAttribute('aria-selected', 'true');
		await tags.press('Tab');
		await expect(tags).toBeFocused();
		await tags.pressSequentially('qx');
		await tags.press('ArrowDown');
		await tags.press(' ');
		const chips = page.getByRole('button', { name: /^Edit tag / });
		await expect(chips).toHaveText(['qxtwo', 'qxone']);
		await tags.pressSequentially('qy');
		await expect(options).toHaveText(['qyak']);
		await tags.press('Escape');
		await expect(page.locator('#edit-tags-list')).toBeHidden();
		await expect(page).toHaveURL(/new=1/);
		expect(dialogs).toEqual([]);
		expect(errors).toEqual([]);
	});

	test('on a phone the bar shows only while a field has focus', async ({
		page,
		context,
		baseURL
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		await page.goto('/cards/browse?new=1');
		await page.waitForLoadState('networkidle');
		const bar = page.getByRole('toolbar', { name: 'Formatting' });
		await expect(bar).toBeHidden();
		await page.locator('div#edit-front').click();
		await expect(bar).toBeVisible();
		// One row that scrolls sideways, never a wrap that eats the screen. The sheet clips
		// what spills, so the bar's own edge is what shows a row too wide for the phone.
		const box = await bar.boundingBox();
		expect(box!.height).toBeLessThan(60);
		expect(box!.x + box!.width).toBeLessThanOrEqual(390);
		// A tap that misses a button, on a gap or a separator, keeps the field's focus.
		const gap = await bar.locator('span[aria-hidden="true"]').first().boundingBox();
		await page.mouse.click(gap!.x + gap!.width / 2, gap!.y + gap!.height / 2);
		await expect(page.locator('div#edit-front')).toBeFocused();
		await expect(bar).toBeVisible();
		await page.locator('#edit-deck').click();
		await expect(bar).toBeHidden();
	});

	test('a re-import keeps a card edited here, and says so', async ({ page, context, baseURL }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.addCookies([{ name: 'auth-session', value: token, url: baseURL! }]);
		const deck = 'E2E Editor import';
		const tsv = (front: string) =>
			`#separator:tab\n#html:true\n#guid column:1\n#deck column:2\ne2eKeepGuid\t${deck}\t${front}\tback\n`;
		async function upload(front: string) {
			await page.goto('/cards');
			await page.getByLabel('Anki export').setInputFiles({
				name: 'deck.txt',
				mimeType: 'text/plain',
				buffer: Buffer.from(tsv(front))
			});
			await page.getByRole('button', { name: 'Import deck' }).click();
		}

		await upload('from anki');
		await expect(page.getByText('Imported 1 cards.')).toBeVisible();
		const [{ id }] =
			await sql`select id from nodes where user_id = ${USER_ID} and deck = ${deck} and kind = 'card'`;
		await page.goto(`/cards/browse?card=${id}`);
		await typeInto(page, '#edit-front', 'fixed here');
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.getByText('Saved.')).toBeVisible();

		await upload('from anki again');
		await expect(page.getByText(/Imported 0 cards\. Kept your edits to 1/)).toBeVisible();
		const [row] = await sql`select front from nodes where id = ${id}`;
		expect(row.front).toBe('fixed here');
	});
});
