import { expect, test } from '@playwright/test';

// A shared remediate.app link should unfurl with a title, description and image.
test('landing page carries link-preview metadata', async ({ page, request }) => {
	await page.goto('/');
	const meta = (selector: string) => page.locator(selector).getAttribute('content');

	expect(await meta('meta[property="og:title"]')).toBe('Remediate');
	expect(await meta('meta[property="og:description"]')).toBeTruthy();
	expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
	expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(
		'https://www.remediate.app/'
	);

	const image = await meta('meta[property="og:image"]');
	expect(image).toBe('https://www.remediate.app/og.png');
	const res = await request.get(new URL(image!).pathname);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('image/png');
});

test('robots.txt keeps crawlers on public pages', async ({ request }) => {
	const res = await request.get('/robots.txt');
	expect(res.status()).toBe(200);
	const body = await res.text();
	expect(body).toContain('Disallow: /cards');
	expect(body).toContain('Disallow: /api');
	expect(body).toContain('Disallow: /quest');
});
