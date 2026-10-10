import { expect, test } from '@playwright/test';

// Size and alpha from the IHDR chunk that opens every PNG. Colour types 4 and 6 carry
// alpha, and iOS fills transparent icon pixels with black.
function png(body: Buffer) {
	return { width: body.readUInt32BE(16), height: body.readUInt32BE(20), alpha: body[25] >= 4 };
}

test('the manifest opens the installed app standalone on the decks', async ({ page, request }) => {
	await page.goto('/');
	const href = await page.locator('link[rel="manifest"]').getAttribute('href');
	const res = await request.get(href!);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('application/manifest+json');

	const manifest = await res.json();
	expect(manifest).toMatchObject({ display: 'standalone', start_url: '/cards', scope: '/' });
	expect(manifest.icons.map((i: { purpose: string }) => i.purpose)).toContain('maskable');
	for (const icon of manifest.icons) {
		const [width, height] = icon.sizes.split('x').map(Number);
		const body = await (await request.get(icon.src)).body();
		expect(png(body), icon.src).toEqual({ width, height, alpha: false });
	}
});

test('iOS gets an opaque touch icon, a title and an opaque status bar', async ({
	page,
	request
}) => {
	await page.goto('/');
	const attr = (selector: string, name: string) => page.locator(selector).getAttribute(name);

	const icon = await attr('link[rel="apple-touch-icon"]', 'href');
	expect(png(await (await request.get(icon!)).body())).toEqual({
		width: 180,
		height: 180,
		alpha: false
	});
	expect(await attr('meta[name="apple-mobile-web-app-title"]', 'content')).toBe('Remediate');
	expect(await attr('meta[name="apple-mobile-web-app-status-bar-style"]', 'content')).toBe(
		'default'
	);
	expect(await attr('meta[name="viewport"]', 'content')).toContain('viewport-fit=cover');
});

// iOS skips a startup image whose pixels differ from the screen its media query names.
test('every launch screen matches its screen, in both orientations and themes', async ({
	page,
	request
}) => {
	await page.goto('/login');
	const links = await page
		.locator('link[rel="apple-touch-startup-image"]')
		.evaluateAll((els) => els.map((el) => [el.getAttribute('href')!, el.getAttribute('media')!]));
	expect(links.length).toBeGreaterThan(0);

	const variants = new Map<string, Set<string>>();
	for (const [href, media] of links) {
		const n = (feature: string) => Number(media.match(new RegExp(`${feature}: ([\\d.]+)`))![1]);
		const [w, h, ratio] = [n('device-width'), n('device-height'), n('-webkit-device-pixel-ratio')];
		const landscape = media.includes('orientation: landscape');
		const scheme = media.match(/prefers-color-scheme: (light|dark)/)![1];

		const res = await request.get(href);
		expect(res.status(), href).toBe(200);
		expect(png(await res.body()), href).toEqual({
			width: (landscape ? h : w) * ratio,
			height: (landscape ? w : h) * ratio,
			alpha: false
		});

		const screen = `${w}x${h}@${ratio}`;
		variants.set(screen, (variants.get(screen) ?? new Set()).add(`${landscape}-${scheme}`));
	}
	for (const [screen, set] of variants) expect(set.size, screen).toBe(4);
});

test('offline, a page load shows the offline page, and Try again recovers', async ({
	page,
	context
}) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);

	// The landing page was just loaded online. Seeing the offline page instead proves the
	// worker does not answer navigations from a page cache.
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
	expect(new URL(page.url()).pathname).toBe('/');

	await context.setOffline(false);
	await page.getByRole('link', { name: 'Try again' }).click();
	await expect(page.getByRole('heading', { name: "You're offline" })).toHaveCount(0);
	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Remediate');
});

test('offline, a plain form post shows the offline page', async ({ page, context }) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();

	// Log out and delete deck submit without JS, as POST navigations.
	await context.setOffline(true);
	await page.evaluate(() => {
		const form = Object.assign(document.createElement('form'), {
			method: 'POST',
			action: '/login?/logout'
		});
		document.body.append(form);
		form.submit();
	});
	await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
});

test('the worker caches only the offline page and its fonts, and drops older caches', async ({
	page,
	context
}) => {
	// A cache left by an earlier deploy. offline.html registers no worker.
	await page.goto('/offline.html');
	await page.evaluate(() => caches.open('assets-stale'));

	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await expect
		.poll(() => page.evaluate(() => caches.keys()))
		.toEqual([expect.stringMatching(/^assets-(?!stale)/)]);
	const cached = await page.evaluate(async () => {
		const cache = await caches.open((await caches.keys())[0]);
		return (await cache.keys()).map((r) => new URL(r.url).pathname);
	});
	expect(cached).toContain('/offline.html');
	for (const path of cached)
		expect(path === '/offline.html' || path.startsWith('/fonts/'), path).toBe(true);

	// A controlled page gets the font from the worker, past the HTTP cache.
	await page.reload();
	await context.setOffline(true);
	const status = await page.evaluate(
		async () => (await fetch('/fonts/space-grotesk-latin.woff2', { cache: 'no-store' })).status
	);
	expect(status).toBe(200);
});
