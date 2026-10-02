import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import { db } from '../db';
import * as table from '../db/schema';
import { internalId } from '../ingest/identity';
import { sanitizeCardHtml } from '../ingest/sanitize';
import { contentHashOf, harvestUrl, type HarvestResult } from './harvest';
import { domainOf, normalizeUrl } from './normalize-url';

// The harvest queue (TDD §6), on the `harvests` table. A row moves:
//
//   queued ──fetch──▶ ready ──accept──▶ accepted (a card now exists)
//             │         └──discard──▶ discarded
//             └──────▶ failed ──retry──▶ queued
//   ready ──same story already kept──▶ duplicate
//
// Nothing is dropped: a paywall is a `ready` row at the metadata tier, and a
// broken link is a `failed` row with its reason.

export const STATUSES = [
	'ready',
	'queued',
	'failed',
	'duplicate',
	'accepted',
	'discarded'
] as const;
export type Status = (typeof STATUSES)[number];

/** What the review page shows for a harvested page. Stored in `harvests.proposal`. */
export interface Proposal {
	title: string | null;
	description: string | null;
	siteName: string | null;
	author: string | null;
	publishedAt: string | null;
	image: string | null;
	finalUrl: string | null;
	/** The first stretch of article text, full tier only. */
	excerpt: string | null;
	source: 'fetch' | 'articles.csv';
}

const h = table.harvest;
const BATCH = 500;

/** Queue URLs for fetching. A URL already harvested is left as it is. */
export async function queueUrls(userId: string, urls: string[]) {
	const normalized = [...new Set(urls.map(normalizeUrl).filter((u): u is string => u !== null))];
	let queued = 0;
	await db.transaction(async (tx) => {
		for (let i = 0; i < normalized.length; i += BATCH) {
			const rows = await tx
				.insert(h)
				.values(normalized.slice(i, i + BATCH).map((urlNormalized) => ({ userId, urlNormalized })))
				.onConflictDoNothing()
				.returning({ id: h.id });
			queued += rows.length;
		}
	});
	return { queued, already: normalized.length - queued };
}

// Postgres text and jsonb refuse U+0000, and one would fail the whole CSV import.
const clip = (s: string | undefined, max = 1000) =>
	s ? s.replaceAll('\u0000', '').trim().slice(0, max) || null : null;

/**
 * Backfill from `source_data/articles.csv` (id, date, url, title, description,
 * image, author): the metadata saved with each bookmark, so every row lands
 * `ready` at the metadata tier without a fetch. Rows whose URL is already
 * harvested are skipped.
 */
export async function importArticlesCsv(userId: string, raw: string) {
	const rows: Record<string, string>[] = parse(raw.replace(/^\uFEFF/, ''), {
		columns: (header: string[]) => header.map((c) => c.trim().toLowerCase()),
		relax_column_count: true,
		relax_quotes: true,
		skip_empty_lines: true
	});
	if (rows.length && !('url' in rows[0])) throw new Error('No url column.');
	const byUrl = new Map<string, typeof table.harvest.$inferInsert>();
	let skipped = 0;
	for (const r of rows) {
		const url = normalizeUrl(r.url ?? '');
		if (!url) {
			skipped += 1;
			continue;
		}
		const title = clip(r.title);
		const proposal: Proposal = {
			title,
			description: clip(r.description),
			siteName: clip(r.author, 200),
			author: null,
			publishedAt: clip(r.date, 64),
			image: null,
			finalUrl: null,
			excerpt: null,
			source: 'articles.csv'
		};
		byUrl.set(url, {
			userId,
			urlNormalized: url,
			status: title ? 'ready' : 'queued',
			tier: title ? 'metadata' : null,
			proposal,
			contentHash: contentHashOf({ text: '', title })
		});
	}
	const values = [...byUrl.values()];
	let added = 0;
	await db.transaction(async (tx) => {
		for (let i = 0; i < values.length; i += BATCH) {
			const out = await tx
				.insert(h)
				.values(values.slice(i, i + BATCH))
				.onConflictDoNothing()
				.returning({ id: h.id });
			added += out.length;
		}
	});
	const duplicates = await markDuplicates(userId);
	return { rows: rows.length, added, already: values.length - added, skipped, duplicates };
}

/** Mark `ready` rows whose story an earlier row already holds. Returns how many. */
export async function markDuplicates(userId: string): Promise<number> {
	const rows = await db.execute(sql`
		update ${h} set status = 'duplicate'
		where ${h.userId} = ${userId} and ${h.status} = 'ready' and ${h.contentHash} is not null
		and exists (
			select 1 from ${h} o
			where o.user_id = ${h.userId} and o.content_hash = ${h.contentHash} and o.id < ${h.id}
			and o.status in ('ready', 'accepted')
		)
		returning ${h.id}`);
	return rows.length;
}

function proposalOf(r: HarvestResult): Proposal {
	return {
		title: r.title,
		description: r.description,
		siteName: r.siteName,
		author: r.author,
		publishedAt: r.publishedAt,
		image: r.image,
		finalUrl: r.finalUrl,
		excerpt: r.text ? r.text.slice(0, 600) : null,
		source: 'fetch'
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-domain spacing (TDD §6.3): a site sees at most one request a second from us. */
export const SPACING_MS = 1000;

/**
 * Fetch queued rows, oldest first, until `max` are done or `budgetMs` has passed.
 * One request runs at a time, and the same domain waits SPACING_MS between hits.
 * Returns how many were fetched and how many remain.
 */
export async function processQueue(
	userId: string,
	{
		max = 10,
		budgetMs = 8000,
		harvest = harvestUrl
	}: { max?: number; budgetMs?: number; harvest?: (url: string) => Promise<HarvestResult> } = {}
) {
	const started = Date.now();
	const rows = await db
		.select({ id: h.id, url: h.urlNormalized })
		.from(h)
		.where(and(eq(h.userId, userId), eq(h.status, 'queued')))
		.orderBy(asc(h.id))
		.limit(max)
		// A second tab, or an auto-continue that overlaps the last round, takes the
		// rows after these rather than fetching the same pages again. The locks last
		// as long as the request's transaction (asTenant).
		.for('update', { skipLocked: true });
	const lastHit = new Map<string, number>();
	let done = 0;
	for (const row of rows) {
		const domain = domainOf(row.url);
		const wait = (lastHit.get(domain) ?? 0) + SPACING_MS - Date.now();
		if (Date.now() - started + Math.max(0, wait) > budgetMs) break;
		if (wait > 0) await sleep(wait);
		lastHit.set(domain, Date.now());
		const r = await harvest(row.url);
		await db
			.update(h)
			.set({
				status: r.tier === 'failed' ? 'failed' : 'ready',
				tier: r.tier,
				proposal: proposalOf(r),
				contentHash: r.contentHash,
				failReason: r.failReason
			})
			.where(and(eq(h.id, row.id), eq(h.userId, userId)));
		done += 1;
		if (Date.now() - started > budgetMs) break;
	}
	if (done) await markDuplicates(userId);
	return { done, remaining: await countStatus(userId, 'queued') };
}

async function countStatus(userId: string, status: Status) {
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(h)
		.where(and(eq(h.userId, userId), eq(h.status, status)));
	return n;
}

export const PAGE_SIZE = 25;

export async function listHarvests(userId: string, status: Status, page = 1) {
	const counts = await db
		.select({ status: h.status, n: sql<number>`count(*)::int` })
		.from(h)
		.where(eq(h.userId, userId))
		.groupBy(h.status);
	const count = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
	for (const c of counts) if (c.status in count) count[c.status as Status] = c.n;
	const pages = Math.max(1, Math.ceil(count[status] / PAGE_SIZE));
	const current = Math.min(Math.max(1, page), pages);
	const rows = await db
		.select({
			id: h.id,
			url: h.urlNormalized,
			tier: h.tier,
			proposal: h.proposal,
			failReason: h.failReason,
			nodeId: h.nodeId
		})
		.from(h)
		.where(and(eq(h.userId, userId), eq(h.status, status)))
		.orderBy(asc(h.id))
		.limit(PAGE_SIZE)
		.offset((current - 1) * PAGE_SIZE);
	return {
		count,
		page: current,
		pages,
		items: rows.map((r) => ({
			id: String(r.id),
			url: r.url,
			domain: domainOf(r.url),
			tier: r.tier,
			proposal: (r.proposal as Proposal | null) ?? null,
			failReason: r.failReason,
			nodeId: r.nodeId
		}))
	};
}

const toIds = (ids: string[]) => ids.filter((id) => /^\d{1,18}$/.test(id)).map((id) => BigInt(id));

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The card a harvested page becomes: its title on the front, the gist and the link on the back. */
export function cardFor(url: string, p: Proposal | null) {
	const title = p?.title ?? domainOf(url);
	const site = p?.siteName ? ` <span>(${escapeHtml(p.siteName)})</span>` : '';
	const gist = p?.description ?? p?.excerpt ?? '';
	const link = p?.finalUrl ?? url;
	return {
		front: sanitizeCardHtml(`${escapeHtml(title)}${site}`),
		back: sanitizeCardHtml(
			`${gist ? `<p>${escapeHtml(gist)}</p>` : ''}<p><a href="${escapeHtml(link)}">${escapeHtml(domainOf(link))}</a></p>`
		)
	};
}

/**
 * Turn ready rows into cards in `deck` with `tags`. The node id derives from the
 * URL, so accepting the same page twice updates one card. Returns how many.
 */
export async function acceptHarvests(userId: string, ids: string[], deck: string, tags: string[]) {
	const wanted = toIds(ids);
	if (!wanted.length) return 0;
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(h)
			.where(
				and(eq(h.userId, userId), inArray(h.id, wanted), inArray(h.status, ['ready', 'duplicate']))
			);
		for (const r of rows) {
			const proposal = r.proposal as Proposal | null;
			const id = internalId(userId, `url:${r.urlNormalized}`);
			const card = cardFor(r.urlNormalized, proposal);
			await tx
				.insert(table.node)
				.values({
					id,
					userId,
					kind: 'card',
					deck,
					tags,
					url: proposal?.finalUrl ?? r.urlNormalized,
					extractionTier: r.tier,
					...card
				})
				.onConflictDoUpdate({
					target: table.node.id,
					set: { deck, tags, front: card.front, back: card.back }
				});
			await tx.update(h).set({ status: 'accepted', nodeId: id }).where(eq(h.id, r.id));
		}
		return rows.length;
	});
}

/** Move rows to a status: discard ready ones, or re-queue failed ones. */
export async function setStatus(
	userId: string,
	ids: string[],
	to: 'discarded' | 'queued',
	from: Status[]
) {
	const wanted = toIds(ids);
	if (!wanted.length) return 0;
	const rows = await db
		.update(h)
		.set({ status: to, ...(to === 'queued' ? { failReason: null } : {}) })
		.where(and(eq(h.userId, userId), inArray(h.id, wanted), inArray(h.status, from)))
		.returning({ id: h.id });
	return rows.length;
}

/** The user's decks, for the "add to deck" picker. */
export async function deckNames(userId: string) {
	const rows = await db
		.selectDistinct({ deck: table.node.deck })
		.from(table.node)
		.where(and(eq(table.node.userId, userId), eq(table.node.kind, 'card')))
		.orderBy(asc(table.node.deck));
	return rows.map((r) => r.deck);
}
