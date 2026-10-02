import { describe, expect, it } from 'vitest';
import { domainOf, extractUrls, normalizeUrl } from './normalize-url';

describe('normalizeUrl', () => {
	it.each([
		['https://Example.COM/a/', 'https://example.com/a'],
		['https://example.com/', 'https://example.com/'],
		['https://example.com/a#section', 'https://example.com/a'],
		['https://example.com/a?utm_source=x&utm_medium=y', 'https://example.com/a'],
		['https://example.com/a?b=2&a=1&fbclid=z', 'https://example.com/a?a=1&b=2'],
		['https://example.com/a?UTM_Campaign=x&id=7', 'https://example.com/a?id=7'],
		['http://example.com:80/a', 'http://example.com/a'],
		['https://example.com:443/a', 'https://example.com/a'],
		['  https://example.com/a  ', 'https://example.com/a'],
		// The query stays as written: re-encoding it can change what the server returns.
		['https://example.com/s?q=a/b&path=%2Fx', 'https://example.com/s?path=%2Fx&q=a/b'],
		['https://example.com/s?q=a%20b&flag', 'https://example.com/s?flag&q=a%20b'],
		['https://example.com/s?utm_source=x', 'https://example.com/s'],
		// The real corpus: Bloomberg via Apple News carries three utm parameters.
		[
			'https://www.bloomberg.com/news/articles/2023-01-10/is-green-hydrogen?utm_campaign=news&utm_medium=bd&utm_source=applenews',
			'https://www.bloomberg.com/news/articles/2023-01-10/is-green-hydrogen'
		]
	])('%s → %s', (input, out) => {
		expect(normalizeUrl(input)).toBe(out);
	});

	it.each([
		'',
		'not a url',
		'ftp://example.com/a',
		'javascript:alert(1)',
		'file:///etc/passwd',
		'https://user:pass@example.com/',
		`https://example.com/${'a'.repeat(3000)}`
	])('refuses %s', (input) => {
		expect(normalizeUrl(input)).toBeNull();
	});
});

describe('extractUrls', () => {
	it('finds links in lines, prose and bookmark HTML, once each', () => {
		const text = [
			'https://a.test/one',
			'See https://b.test/two, and (https://c.test/three).',
			'<DT><A HREF="https://d.test/four?x=1&amp;y=2" ADD_DATE="1">Four</A>',
			'https://a.test/one#again'
		].join('\n');
		expect(extractUrls(text)).toEqual([
			'https://a.test/one',
			'https://b.test/two',
			'https://c.test/three',
			'https://d.test/four?x=1&y=2'
		]);
	});

	it('keeps a parenthesis the link opened, and drops the one prose closed', () => {
		expect(
			extractUrls(
				'Read (see https://en.wikipedia.org/wiki/Mercury_(planet)). Or https://a.test/x).'
			)
		).toEqual(['https://en.wikipedia.org/wiki/Mercury_(planet)', 'https://a.test/x']);
	});

	it('ignores non-http schemes', () => {
		expect(extractUrls('mailto:a@b.test javascript:alert(1)')).toEqual([]);
	});
});

describe('domainOf', () => {
	it('drops www', () => {
		expect(domainOf('https://www.wsj.com/articles/x')).toBe('wsj.com');
		expect(domainOf('https://apple.news/A1')).toBe('apple.news');
	});
});
