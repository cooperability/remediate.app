import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAnkiExport } from './anki-tsv';
import { sanitizeCardHtml } from './sanitize';

describe('script execution', () => {
	it.each([
		['<script>alert(1)</script>', 'alert'],
		['<img src=x onerror=alert(1)>', 'onerror'],
		['<svg/onload=alert(1)>', 'onload'],
		['<iframe src="https://evil.test"></iframe>', 'iframe'],
		['<body onload=alert(1)>', 'onload'],
		['<math><mtext><style><img src=x onerror=alert(1)>', 'onerror'],
		['<form action="https://evil.test"><input name="x">', 'form'],
		['<object data="data:text/html,<script>alert(1)</script>">', 'object'],
		['<embed src="https://evil.test">', 'embed'],
		['<style>@import "https://evil.test"</style>', 'import']
	])('removes %s', (dirty, forbidden) => {
		expect(sanitizeCardHtml(dirty).toLowerCase()).not.toContain(forbidden);
	});
});

describe('link hrefs', () => {
	it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x'])(
		'strips the href %s',
		(href) => {
			const out = sanitizeCardHtml(`<a href="${href}">click</a>`);
			expect(out).not.toContain('href');
			// The text survives; only the dangerous attribute goes.
			expect(out).toContain('click');
		}
	);

	it.each(['https://en.wikipedia.org/wiki/SSH', 'http://example.test', 'mailto:a@b.test'])(
		'keeps the href %s',
		(href) => {
			expect(sanitizeCardHtml(`<a href="${href}">x</a>`)).toContain(href);
		}
	);

	it('adds target and rel to every surviving link', () => {
		const out = sanitizeCardHtml('<a href="https://example.test">x</a>');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});
});

describe('allowlist', () => {
	it('keeps the tags Anki actually writes', () => {
		const html =
			'<div><b>b</b><i>i</i><u>u</u><em>e</em><strong>s</strong><br><p>p</p>' +
			'<ul><li>li</li></ul><ol><li>li</li></ol><code>c</code><pre>p</pre>' +
			'<span>s</span><sup>1</sup><sub>2</sub><table><tr><th>h</th><td>d</td></tr></table></div>';
		const out = sanitizeCardHtml(html);

		for (const tag of [
			'div',
			'b',
			'i',
			'u',
			'em',
			'strong',
			'br',
			'p',
			'ul',
			'ol',
			'li',
			'code',
			'pre',
			'span',
			'sup',
			'sub',
			'table',
			'tr',
			'th',
			'td'
		]) {
			expect(out).toContain(`<${tag}`);
		}
	});

	it('drops data attributes', () => {
		expect(sanitizeCardHtml('<div data-guid="tNcJ[p<DNp">x</div>')).not.toContain('data-guid');
	});

	it('drops style and event attributes but keeps class, src and alt', () => {
		const out = sanitizeCardHtml(
			'<img src="https://a.test/a.png" alt="a" class="c" style="x" onclick="y">'
		);
		expect(out).toContain('src="https://a.test/a.png"');
		expect(out).toContain('alt="a"');
		expect(out).toContain('class="c"');
		expect(out).not.toContain('style');
		expect(out).not.toContain('onclick');
	});

	it('returns an empty string for empty input', () => {
		expect(sanitizeCardHtml('')).toBe('');
	});

	it('leaves plain text and entities alone', () => {
		expect(sanitizeCardHtml('400-700nm')).toBe('400-700nm');
		expect(sanitizeCardHtml('a &amp; b')).toBe('a &amp; b');
	});

	it('escapes a bare angle bracket rather than dropping the text', () => {
		expect(sanitizeCardHtml('a < b')).toContain('a ');
	});
});

describe('the real corpus', () => {
	// Sanitize through the real path. The raw export is RFC4180, so an internal quote
	// is doubled on disk: handing the file to the sanitizer directly presents
	// `href=""https://…""`, which parses as an empty href and is correctly stripped.
	// Parsing first is what production does, and it is the only input the sanitizer
	// ever sees.
	const raw = readFileSync('source_data/CompSci (AIML_Web3_Math_Logic_Tech).txt', 'utf8');
	const notes = parseAnkiExport(raw, 'user_alice').notes;
	const rendered = notes.map((n) => `${n.front}\n${n.back}`).join('\n');

	it('parses the corpus the sanitizer is measured on', () => {
		expect(notes).toHaveLength(137);
	});

	it('preserves the Wikipedia links the cards depend on', () => {
		// Both exports declare #html:true and the cards carry live links.
		expect(rendered).toContain('https://en.wikipedia.org/wiki/Cryptography');
		expect(rendered).toContain('rel="noopener noreferrer"');
	});

	it('produces no script or event handlers from the whole file', () => {
		const out = rendered.toLowerCase();
		expect(out).not.toContain('<script');
		expect(out).not.toContain('javascript:');
		expect(out).not.toContain('onerror');
	});
});

describe('card media', () => {
	it('drops the src of a bare Anki media filename and names it instead', () => {
		const out = sanitizeCardHtml('<img src="Screenshot 2022-12-12 at 4.00.40 PM.png">');
		expect(out).not.toContain('src=');
		expect(out).toContain('alt="[image: Screenshot 2022-12-12 at 4.00.40 PM.png]"');
		expect(out).toContain('class="media-missing"');
	});

	it.each(['../secret.png', '/cards/x.png', '//evil.test/x.png', 'javascript:alert(1)'])(
		'fetches nothing for %s',
		(src) => {
			expect(sanitizeCardHtml(`<img src="${src}">`)).not.toContain('src=');
		}
	);

	it('keeps https and data images', () => {
		expect(sanitizeCardHtml('<img src="https://a.test/x.png">')).toContain(
			'src="https://a.test/x.png"'
		);
		expect(sanitizeCardHtml('<img src="data:image/png;base64,AAAA">')).toContain(
			'src="data:image/png;base64,AAAA"'
		);
	});

	it('upgrades http images to https', () => {
		expect(sanitizeCardHtml('<img src="http://a.test/x.png">')).toContain(
			'src="https://a.test/x.png"'
		);
	});

	it('leaves no fetchable local image in the real exports', () => {
		for (const f of [
			'source_data/Anthro (Psych_Soc_Econ_Health).txt',
			'source_data/CompSci (AIML_Web3_Math_Logic_Tech).txt'
		]) {
			const { notes } = parseAnkiExport(readFileSync(f, 'utf8'), 'u');
			const html = notes.map((n) => n.front + n.back).join('\n');
			const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
			expect(srcs.filter((s) => !/^(https:|data:image\/)/.test(s))).toEqual([]);
			expect(html).toContain('media-missing');
		}
	});
});
