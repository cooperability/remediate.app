// Tiered extraction (TDD §6.1). A harvested page lands as one of three tiers, and
// none of them is dropped:
//
//   full      readable article text, at least FULL_MIN characters
//   metadata  a title (and usually a description) but no usable body: a paywall,
//             an app shell, a JS redirect. About 45% of the real corpus.
//   failed    nothing usable: an error page, a non-HTML response, a blocked fetch
//
// A single forward scan, not a DOM and not backtracking regexes: this runs on
// untrusted HTML in a serverless function, and a lazy `<p>[\s\S]*?</p>` over a
// page of unclosed tags is quadratic (30 s on 200k of them, measured). Every
// search below is an indexOf that only moves forward.

export type Tier = 'full' | 'metadata' | 'failed';

export interface Extracted {
	tier: Tier;
	title: string | null;
	description: string | null;
	siteName: string | null;
	author: string | null;
	publishedAt: string | null;
	image: string | null;
	canonical: string | null;
	/** Readable body text, empty below the full tier. */
	text: string;
}

/** Body text at least this long is an article, not a teaser. About 200 words. */
export const FULL_MIN = 1200;
const MAX_TEXT = 100_000;
const MAX_FIELD = 1000;

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“'
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
		if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
		const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});
}

const clean = (s: string | null | undefined, max = MAX_FIELD) => {
	if (!s) return null;
	const t = decodeEntities(s).replaceAll('\u0000', '').replace(/\s+/g, ' ').trim();
	return t ? t.slice(0, max) : null;
};

/** Input past this is ignored: an article's head and body fit well inside it. */
const MAX_HTML = 1024 * 1024;
/** Attributes of a longer tag are not read. Real meta and link tags are short. */
const MAX_TAG = 4096;

/** Attributes of one tag, lowercased names. */
function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (tag.length > MAX_TAG) return out;
	for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
		out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
	}
	return out;
}

// Raw-text elements: their content is not markup, so skip to the closing tag.
const RAW = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'svg', 'math']);
// Page chrome whose paragraphs are not the article.
const CHROME = new Set(['nav', 'header', 'footer', 'aside', 'form']);

interface Scan {
	title: string | null;
	meta: Map<string, string>;
	links: { rel: string; href: string }[];
	/** Paragraphs inside <article>, inside <main>, and anywhere. */
	article: string[];
	main: string[];
	all: string[];
}

/** One pass over the page: head fields and body paragraphs. */
function scan(input: string): Scan {
	// NUL is dropped: Postgres text and jsonb cannot hold it, and one would fail the row's write.
	const html = (input.length > MAX_HTML ? input.slice(0, MAX_HTML) : input).replaceAll(
		'\u0000',
		''
	);
	// ASCII only. Tag names are ASCII, and toLowerCase() can change a string's
	// length ('İ' becomes two code units), which would shift every index below.
	const lower = html.replace(/[A-Z]+/g, (c) => c.toLowerCase());
	const out: Scan = { title: null, meta: new Map(), links: [], article: [], main: [], all: [] };
	let chrome = 0;
	let inArticle = 0;
	let inMain = 0;
	let para: string[] | null = null;
	let paraIn = { article: false, main: false };
	let total = 0;

	const flush = () => {
		if (!para) return;
		const text = clean(para.join(' '), MAX_TEXT);
		para = null;
		// Bylines, captions and "Share this" rows are short. Keep sentences.
		if (!text || text.length < 40 || total > MAX_TEXT) return;
		total += text.length;
		out.all.push(text);
		if (paraIn.main) out.main.push(text);
		if (paraIn.article) out.article.push(text);
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		const textEnd = lt === -1 ? html.length : lt;
		if (para && chrome === 0 && textEnd > i) para.push(html.slice(i, textEnd));
		if (lt === -1) break;

		if (lower.startsWith('<!--', lt)) {
			const close = lower.indexOf('-->', lt + 4);
			if (close === -1) break;
			i = close + 3;
			continue;
		}
		const gt = html.indexOf('>', lt + 1);
		if (gt === -1) break;
		const tag = html.slice(lt, gt + 1);
		i = gt + 1;
		const m = /^<\/?([a-z][a-z0-9-]*)/i.exec(tag);
		if (!m) continue;
		const name = m[1].toLowerCase();
		const closing = tag[1] === '/';

		if (!closing && RAW.has(name)) {
			const close = lower.indexOf(`</${name}`, i);
			if (close === -1) break;
			i = lower.indexOf('>', close);
			i = i === -1 ? html.length : i + 1;
			continue;
		}
		if (!closing && name === 'title' && out.title === null) {
			const close = lower.indexOf('</title', i);
			if (close === -1) break;
			out.title = html.slice(i, close);
			i = close;
			continue;
		}
		if (!closing && name === 'meta') {
			const a = attrs(tag);
			const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
			if (key && a.content !== undefined && !out.meta.has(key)) out.meta.set(key, a.content);
			continue;
		}
		if (!closing && name === 'link') {
			const a = attrs(tag);
			if (a.rel && a.href) out.links.push({ rel: a.rel.toLowerCase(), href: a.href });
			continue;
		}
		if (CHROME.has(name)) {
			chrome = Math.max(0, chrome + (closing ? -1 : 1));
			continue;
		}
		if (name === 'article') inArticle = Math.max(0, inArticle + (closing ? -1 : 1));
		if (name === 'main') inMain = Math.max(0, inMain + (closing ? -1 : 1));
		if (name === 'p') {
			// An open <p> ends at the next one, as in HTML.
			flush();
			if (!closing && chrome === 0) {
				para = [];
				paraIn = { article: inArticle > 0, main: inMain > 0 };
			}
			continue;
		}
		// Inline tags inside a paragraph separate words, nothing more.
		if (para && chrome === 0) para.push(' ');
		if (closing && (name === 'div' || name === 'section' || name === 'body')) flush();
	}
	flush();
	return out;
}

/** Readable paragraphs: <p> text inside <article>, else <main>, else the page. */
export function readableText(html: string): string {
	const s = scan(html);
	const chosen = s.article.length ? s.article : s.main.length ? s.main : s.all;
	return chosen.join('\n\n').slice(0, MAX_TEXT);
}

function absolute(href: string | null, base: string): string | null {
	if (!href) return null;
	try {
		const u = new URL(decodeEntities(href), base);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
	} catch {
		return null;
	}
}

/** Pull the tiered record out of an HTML page fetched from `url`. */
export function extractFromHtml(html: string, url: string): Extracted {
	const page = scan(html);
	const get = (...keys: string[]) =>
		keys.map((k) => page.meta.get(k)).find((v) => v?.trim()) ?? null;
	const canonical = page.links.find((l) => l.rel.split(/\s+/).includes('canonical'))?.href ?? null;

	const title = clean(get('og:title', 'twitter:title') ?? page.title);
	const description = clean(get('og:description', 'twitter:description', 'description'));
	const body = page.article.length ? page.article : page.main.length ? page.main : page.all;
	const text = body.join('\n\n').slice(0, MAX_TEXT);
	const tier: Tier = text.length >= FULL_MIN ? 'full' : title ? 'metadata' : 'failed';
	return {
		tier,
		title,
		description,
		siteName: clean(get('og:site_name', 'application-name')),
		author: clean(get('author', 'article:author', 'parsely-author', 'sailthru.author')),
		publishedAt: clean(get('article:published_time', 'date', 'pubdate', 'parsely-pub-date'), 64),
		image: absolute(get('og:image', 'twitter:image'), url),
		canonical: absolute(canonical, url),
		text: tier === 'full' ? text : ''
	};
}

/** The record for a fetch that produced nothing usable. */
export const failed = (): Extracted => ({
	tier: 'failed',
	title: null,
	description: null,
	siteName: null,
	author: null,
	publishedAt: null,
	image: null,
	canonical: null,
	text: ''
});
