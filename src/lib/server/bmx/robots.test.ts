import { describe, expect, it } from 'vitest';
import { matches, parseRobots, robotsAllow } from './robots';

const allow = (robots: string, url: string) => robotsAllow(parseRobots(robots), url);

describe('robots.txt', () => {
	it('allows everything with no rules or an empty Disallow', () => {
		expect(allow('', 'https://a.test/x')).toBe(true);
		expect(allow('User-agent: *\nDisallow:', 'https://a.test/x')).toBe(true);
	});

	it('applies the * group', () => {
		const r = 'User-agent: *\nDisallow: /private\n';
		expect(allow(r, 'https://a.test/private/page')).toBe(false);
		expect(allow(r, 'https://a.test/public')).toBe(true);
	});

	it('prefers a group naming this agent over *', () => {
		const r = 'User-agent: *\nDisallow: /\n\nUser-agent: RemediateBot\nDisallow: /admin\n';
		expect(allow(r, 'https://a.test/article')).toBe(true);
		expect(allow(r, 'https://a.test/admin')).toBe(false);
	});

	it('lets the longest rule win, Allow on a tie', () => {
		const r = 'User-agent: *\nDisallow: /news\nAllow: /news/open\n';
		expect(allow(r, 'https://a.test/news/closed')).toBe(false);
		expect(allow(r, 'https://a.test/news/open/1')).toBe(true);
	});

	it('supports * and $ in paths', () => {
		const r = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*q=\n';
		expect(allow(r, 'https://a.test/doc.pdf')).toBe(false);
		expect(allow(r, 'https://a.test/doc.pdf.html')).toBe(true);
		expect(allow(r, 'https://a.test/search?page=2&q=x')).toBe(false);
	});

	it('shares rules across consecutive User-agent lines', () => {
		const r = 'User-agent: googlebot\nUser-agent: *\nDisallow: /x\n';
		expect(allow(r, 'https://a.test/x')).toBe(false);
	});

	it('ignores groups for other agents whose name is part of ours', () => {
		const r = 'User-agent: bot\nDisallow: /\n\nUser-agent: *\nDisallow: /x\n';
		expect(allow(r, 'https://a.test/article')).toBe(true);
		expect(allow(r, 'https://a.test/x')).toBe(false);
	});

	it('matches wildcards as prefixes, and exactly with $', () => {
		expect(matches('/a*c', '/abc/more')).toBe(true);
		expect(matches('/a*c$', '/abc/more')).toBe(false);
		expect(matches('/a*c$', '/abxc')).toBe(true);
		expect(matches('/*', '/')).toBe(true);
		expect(matches('/x', '/')).toBe(false);
		expect(matches('*.pdf$', '/a.pdf')).toBe(true);
	});

	// A RegExp built from this rule did not finish in a minute on a 40-character path.
	it('matches a hostile wildcard rule in linear time', () => {
		const rule = '/' + '*a'.repeat(200) + '*b';
		const started = Date.now();
		expect(matches(rule, '/' + 'a'.repeat(2000))).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
