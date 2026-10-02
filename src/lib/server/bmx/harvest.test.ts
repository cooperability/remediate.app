import { beforeEach, describe, expect, it } from 'vitest';
import { clearRobotsCache, contentHashOf, harvestUrl } from './harvest';
import { BlockedError, type FetchResult } from './ssrf';

const ok = (url: string, body: string, contentType = 'text/html'): FetchResult => ({
	url,
	status: 200,
	contentType,
	body,
	truncated: false
});

/** A fake web: path → response. robots.txt 404s unless given. */
function web(pages: Record<string, FetchResult | Error>) {
	const calls: string[] = [];
	const fetcher = async (url: string) => {
		calls.push(url);
		const hit = pages[url];
		if (hit instanceof Error) throw hit;
		return hit ?? { url, status: 404, contentType: 'text/html', body: '', truncated: false };
	};
	return { fetcher, calls };
}

const ARTICLE = `<html><head><title>Story — Paper</title><meta name="description" content="D"></head>
<body><article>${'<p>An actual paragraph of reporting, with enough words to count.</p>'.repeat(40)}</article></body></html>`;

beforeEach(clearRobotsCache);

describe('harvestUrl', () => {
	it('lands a readable article as full', async () => {
		const { fetcher } = web({ 'https://paper.test/s': ok('https://paper.test/s', ARTICLE) });
		const r = await harvestUrl('https://paper.test/s', fetcher);
		expect(r).toMatchObject({ tier: 'full', title: 'Story — Paper', failReason: null });
		expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('lands a paywalled teaser as metadata', async () => {
		const teaser = '<head><meta property="og:title" content="Locked story"></head><p>Subscribe</p>';
		const { fetcher } = web({ 'https://wsj.test/a': ok('https://wsj.test/a', teaser) });
		expect((await harvestUrl('https://wsj.test/a', fetcher)).tier).toBe('metadata');
	});

	it('reports a paywall status, an error status and a non-page as failed with a reason', async () => {
		const { fetcher } = web({
			'https://a.test/403': { ...ok('https://a.test/403', ''), status: 403 },
			'https://a.test/500': { ...ok('https://a.test/500', ''), status: 500 },
			'https://a.test/pdf': ok('https://a.test/pdf', '%PDF', 'application/pdf')
		});
		expect((await harvestUrl('https://a.test/403', fetcher)).failReason).toMatch(/paywall/);
		expect((await harvestUrl('https://a.test/500', fetcher)).failReason).toBe('HTTP 500');
		expect((await harvestUrl('https://a.test/pdf', fetcher)).failReason).toMatch(
			/application\/pdf/
		);
	});

	it('turns a blocked fetch and a network error into failed rows, never a throw', async () => {
		const { fetcher } = web({
			'https://evil.test/x': new BlockedError('evil.test resolves to a non-public address'),
			'https://down.test/x': Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
		});
		expect((await harvestUrl('https://evil.test/x', fetcher)).failReason).toMatch(/^blocked: /);
		expect((await harvestUrl('https://down.test/x', fetcher)).failReason).toBe(
			'network error (ECONNREFUSED)'
		);
	});

	it('honours robots.txt and fetches it once per origin', async () => {
		const { fetcher, calls } = web({
			'https://r.test/robots.txt': ok(
				'https://r.test/robots.txt',
				'User-agent: *\nDisallow: /private',
				'text/plain'
			),
			'https://r.test/open': ok('https://r.test/open', ARTICLE)
		});
		expect((await harvestUrl('https://r.test/private/1', fetcher)).failReason).toMatch(/robots/);
		expect((await harvestUrl('https://r.test/open', fetcher)).tier).toBe('full');
		expect(calls.filter((c) => c.endsWith('/robots.txt'))).toHaveLength(1);
		expect(calls).not.toContain('https://r.test/private/1');
	});

	// RFC 9309 §2.3.1.4: a robots.txt that errors means the site is unreachable.
	it('fetches nothing while robots.txt answers a server error', async () => {
		const { fetcher, calls } = web({
			'https://s.test/robots.txt': { ...ok('https://s.test/robots.txt', ''), status: 503 },
			'https://s.test/a': ok('https://s.test/a', ARTICLE)
		});
		const r = await harvestUrl('https://s.test/a', fetcher);
		expect(r).toMatchObject({ tier: 'failed' });
		expect(r.failReason).toMatch(/robots\.txt answered HTTP 503/);
		expect(calls).not.toContain('https://s.test/a');
	});
});

describe('contentHashOf', () => {
	it('matches one story across publisher suffixes', () => {
		const a = contentHashOf({
			text: '',
			title: 'USPS Is Hiring Trucks to Carry Its Mail — The Wall Street Journal'
		});
		const b = contentHashOf({ text: '', title: 'USPS Is Hiring Trucks to Carry Its Mail | WSJ' });
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it('does not hash a title too short to identify a story', () => {
		expect(contentHashOf({ text: '', title: 'Home' })).toBeNull();
	});
});
