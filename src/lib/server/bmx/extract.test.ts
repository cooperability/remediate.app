import { describe, expect, it } from 'vitest';
import { extractFromHtml, FULL_MIN, readableText } from './extract';

const para = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `<p>Sentence ${i} of the article body, long enough to count.</p>`
	).join('');

const page = (head: string, body: string) =>
	`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('extractFromHtml', () => {
	it('reads Open Graph metadata, entities decoded, relative image made absolute', () => {
		const e = extractFromHtml(
			page(
				`<title>Fallback</title>
				<meta property="og:title" content="Tom &amp; Jerry&#8217;s story">
				<meta content="A short description." name="description">
				<meta property="og:site_name" content="The Paper">
				<meta name="author" content="A. Writer">
				<meta property="article:published_time" content="2023-01-10T10:00:00Z">
				<meta property="og:image" content="/img/lead.jpg">
				<link rel="canonical" href="https://paper.test/story">`,
				'<p>short</p>'
			),
			'https://paper.test/story?x=1'
		);
		expect(e).toMatchObject({
			tier: 'metadata',
			title: 'Tom & Jerry’s story',
			description: 'A short description.',
			siteName: 'The Paper',
			author: 'A. Writer',
			publishedAt: '2023-01-10T10:00:00Z',
			image: 'https://paper.test/img/lead.jpg',
			canonical: 'https://paper.test/story',
			text: ''
		});
	});

	it('falls back to <title>', () => {
		expect(extractFromHtml(page('<title> Plain  title </title>', ''), 'https://a.test').title).toBe(
			'Plain title'
		);
	});

	it('is full when the article body is long enough, and skips nav and scripts', () => {
		const body = `<nav><p>${'Menu item that is quite long indeed. '.repeat(3)}</p></nav>
			<script>var p = "<p>not text at all, a script string here</p>";</script>
			<article>${para(40)}</article>`;
		const e = extractFromHtml(page('<title>T</title>', body), 'https://a.test');
		expect(e.tier).toBe('full');
		expect(e.text.length).toBeGreaterThanOrEqual(FULL_MIN);
		expect(e.text).not.toContain('Menu item');
		expect(e.text).not.toContain('script string');
	});

	it('is failed with neither a title nor text', () => {
		expect(extractFromHtml('<html><body></body></html>', 'https://a.test').tier).toBe('failed');
	});

	it('refuses a javascript: image', () => {
		const e = extractFromHtml(
			page('<title>T</title><meta property="og:image" content="javascript:alert(1)">', ''),
			'https://a.test'
		);
		expect(e.image).toBeNull();
	});
});

describe('text a database write can hold', () => {
	// Postgres refuses U+0000 in text and jsonb, and one would fail the queue's update.
	it('drops NUL from fields and body text', () => {
		const e = extractFromHtml(
			page(
				'<title>Ti\u0000tle</title>',
				`<article>${para(40).replace('Sentence 0', 'Sen\u0000tence 0')}</article>`
			),
			'https://a.test'
		);
		expect(e.title).toBe('Title');
		expect(e.text).not.toContain('\u0000');
		expect(e.tier).toBe('full');
	});

	// 'İ'.toLowerCase() is two code units: a lowercased copy drifts from the original.
	it('reads a page whose text changes length when lowercased', () => {
		const head = `<meta name="keywords" content="${'İstanbul '.repeat(20)}"><title>Türkiye</title>`;
		const e = extractFromHtml(page(head, `<article>${para(40)}</article>`), 'https://a.test');
		expect(e.title).toBe('Türkiye');
		expect(e.text.startsWith('Sentence 0 of the article body')).toBe(true);
	});
});

describe('readableText on hostile input', () => {
	it.each([
		['unclosed paragraphs', '<p>'.repeat(200_000)],
		['unclosed nav', '<nav>'.repeat(100_000)],
		['unclosed comments', '<!--'.repeat(100_000)],
		['huge attribute soup', `<meta ${'a="b" '.repeat(100_000)}>`],
		['unclosed meta tags', '<meta '.repeat(200_000)],
		['unclosed titles', '<title>'.repeat(200_000)],
		['unclosed scripts', '<script>'.repeat(200_000)],
		['a long word run in a tag', `<meta ${'a'.repeat(1_000_000)}>`]
	])('finishes quickly on %s', (_, html) => {
		const t = performance.now();
		readableText(html);
		extractFromHtml(html, 'https://a.test');
		expect(performance.now() - t).toBeLessThan(2000);
	});
});
