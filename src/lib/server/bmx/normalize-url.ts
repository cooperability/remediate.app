// URL identity for the harvest queue (TDD §6). Two links to the same page must
// normalize to one string, or the queue fetches it twice and the graph holds it
// twice. Only changes that cannot alter what the server returns are made.

/** Query parameters that only carry attribution. Matched case-insensitively. */
const TRACKING = new Set([
	'fbclid',
	'gclid',
	'dclid',
	'msclkid',
	'mc_cid',
	'mc_eid',
	'igshid',
	'_hsenc',
	'_hsmi',
	'mkt_tok',
	'yclid',
	'twclid',
	'ocid',
	'cmpid',
	'smid',
	'smtyp'
]);
/** A query pair's key, decoded. */
function keyOf(pair: string): string {
	const key = pair.split('=')[0].replaceAll('+', ' ');
	try {
		return decodeURIComponent(key);
	} catch {
		return key;
	}
}

const isTracking = (key: string) => {
	const k = key.toLowerCase();
	return k.startsWith('utm_') || TRACKING.has(k);
};

/** The longest URL kept. Longer ones are tracking junk or abuse. */
export const MAX_URL = 2048;

/**
 * Canonical form of an http(s) URL, or null if `input` is not one.
 *
 * - scheme and host lowercased, default port and `www.` kept as written
 * - fragment dropped
 * - `utm_*` and known click ids dropped, remaining parameters sorted
 * - a trailing slash dropped from any path but `/`
 * - credentials refused: a pasted `user:pass@` link is never stored
 */
export function normalizeUrl(input: string): string | null {
	const raw = input.trim();
	if (!raw || raw.length > MAX_URL) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	if (u.username || u.password || !u.hostname) return null;
	u.hash = '';
	// Pairs are filtered and sorted as written. Re-serializing through
	// URLSearchParams would re-encode them (`/` to `%2F`, `%20` to `+`, a bare
	// `?flag` to `?flag=`), and some servers answer those differently.
	const pairs = u.search.slice(1).split('&').filter(Boolean);
	const kept = pairs.filter((pair) => !isTracking(keyOf(pair)));
	kept.sort((a, b) => {
		const [ka, kb] = [a.split('=')[0], b.split('=')[0]];
		return ka === kb ? 0 : ka < kb ? -1 : 1;
	});
	u.search = kept.length ? `?${kept.join('&')}` : '';
	if (u.pathname.length > 1 && u.pathname.endsWith('/'))
		u.pathname = u.pathname.replace(/\/+$/, '');
	return u.toString();
}

const count = (s: string, c: string) => s.split(c).length - 1;

/**
 * Drop punctuation that prose puts after a link. A closing parenthesis stays when
 * the link opened one: `wiki/Mercury_(planet)` is the page, `(see https://a.test)`
 * is prose.
 */
function trimTrailing(url: string): string {
	let u = url;
	for (;;) {
		const last = u.at(-1);
		if (last !== undefined && '.,;:!?]}'.includes(last)) u = u.slice(0, -1);
		else if (last === ')' && count(u, '(') < count(u, ')')) u = u.slice(0, -1);
		else return u;
	}
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`]+/gi;

/**
 * Every distinct http(s) URL in pasted text: one per line, prose, or a browser's
 * bookmarks HTML export (`<a href="…">`). Trailing punctuation that prose puts
 * after a link is not part of it. Order of first appearance.
 */
export function extractUrls(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(URL_IN_TEXT)) {
		// '&amp;' is how a bookmarks file writes '&' inside an href.
		const candidate = trimTrailing(m[0].replaceAll('&amp;', '&'));
		const n = normalizeUrl(candidate);
		if (n) out.add(n);
	}
	return [...out];
}

/** Host without a leading `www.`, for grouping and politeness. */
export const domainOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');
