import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { extractFromHtml, failed, type Extracted } from './extract';
import { parseRobots, robotsAllow } from './robots';
import { BlockedError, safeFetch, type FetchOptions, type FetchResult } from './ssrf';

export interface HarvestResult extends Extracted {
	/** Where the page ended up after redirects, when it was fetched. */
	finalUrl: string | null;
	/** Why the tier is `failed`, in words a person can act on. Null otherwise. */
	failReason: string | null;
	/** Same story on two domains hashes the same. Null when there is nothing to hash. */
	contentHash: string | null;
}

type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

const ROBOTS_TTL_MS = 60 * 60 * 1000;
/** A robots.txt that answered 5xx is asked again sooner: the outage is likely brief. */
const ROBOTS_ERROR_TTL_MS = 10 * 60 * 1000;

type Robots = { rules: ReturnType<typeof parseRobots>; unavailable?: number };
const robotsCache = new Map<string, { at: number; ttl: number; robots: Robots }>();
/** Origins remembered at once. A serverless instance is short-lived; this bounds a long one. */
const ROBOTS_CACHE_MAX = 500;

async function robotsFor(url: string, fetcher: Fetcher, now: number): Promise<Robots> {
	const origin = new URL(url).origin;
	const hit = robotsCache.get(origin);
	if (hit && now - hit.at < hit.ttl) return hit.robots;
	let robots: Robots = { rules: [] };
	try {
		const res = await fetcher(`${origin}/robots.txt`, { maxBytes: 256 * 1024, timeoutMs: 5000 });
		// A missing robots.txt (4xx) allows everything (RFC 9309 §2.3.1.3). A server
		// error means the site is unreachable, and then a crawler assumes it may
		// fetch nothing (§2.3.1.4).
		if (res.status >= 200 && res.status < 300) robots = { rules: parseRobots(res.body) };
		else if (res.status >= 500) robots = { rules: [], unavailable: res.status };
	} catch {
		// Unreachable robots.txt: the page fetch reports the real problem.
	}
	robotsCache.delete(origin);
	robotsCache.set(origin, {
		at: now,
		ttl: robots.unavailable ? ROBOTS_ERROR_TTL_MS : ROBOTS_TTL_MS,
		robots
	});
	if (robotsCache.size > ROBOTS_CACHE_MAX) robotsCache.delete(robotsCache.keys().next().value!);
	return robots;
}

const hash = (s: string) => encodeHexLowerCase(sha256(new TextEncoder().encode(s)));

/**
 * A story's identity across domains: the article text when there is one, else
 * its title without the " — Publisher" tail the same story carries on apple.news
 * and on the publisher's own site.
 */
export function contentHashOf(e: Pick<Extracted, 'text' | 'title'>): string | null {
	if (e.text) return hash(e.text.replace(/\s+/g, ' ').trim().toLowerCase());
	if (!e.title) return null;
	const title = e.title
		.replace(/\s+[—–|-]\s+[^—–|-]{2,60}$/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
	return title.length >= 12 ? hash(`title:${title}`) : null;
}

const fail = (reason: string, finalUrl: string | null = null): HarvestResult => ({
	...failed(),
	finalUrl,
	failReason: reason,
	contentHash: null
});

/** Fetch one page politely and extract it. Never throws: a failure is a tier. */
export async function harvestUrl(
	url: string,
	fetcher: Fetcher = safeFetch,
	now = Date.now()
): Promise<HarvestResult> {
	try {
		const robots = await robotsFor(url, fetcher, now);
		if (robots.unavailable) {
			return fail(`the site's robots.txt answered HTTP ${robots.unavailable}; retry later`);
		}
		if (!robotsAllow(robots.rules, url)) return fail('robots.txt disallows fetching this page');
		const res = await fetcher(url);
		if (res.status === 401 || res.status === 402 || res.status === 403) {
			return fail(`the site refused the request (HTTP ${res.status}), likely a paywall`, res.url);
		}
		if (res.status >= 400) return fail(`HTTP ${res.status}`, res.url);
		if (!/html/i.test(res.contentType)) {
			return fail(
				`not a web page (${res.contentType.split(';')[0] || 'no content type'})`,
				res.url
			);
		}
		const e = extractFromHtml(res.body, res.url);
		return {
			...e,
			finalUrl: res.url,
			failReason: e.tier === 'failed' ? 'the page has no title or readable text' : null,
			contentHash: contentHashOf(e)
		};
	} catch (e) {
		if (e instanceof BlockedError) return fail(`blocked: ${e.message}`);
		const err = e as { name?: string; code?: string; message?: string };
		if (err.name === 'TimeoutError' || err.name === 'AbortError') return fail('timed out');
		return fail(err.code ? `network error (${err.code})` : `network error`);
	}
}

/** Test seam: forget cached robots.txt files. */
export const clearRobotsCache = () => robotsCache.clear();
