import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Grade } from 'ts-fsrs';
import { db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { parseAnkiExport } from '$lib/server/ingest/anki-tsv';
import { classify, gradeRound, mergeStanding, standingOf } from './grading';
import { grade, previewIntervals } from './scheduler';
import { NEW_PER_DAY, ROUND_SIZE, selectRound } from './select';

export async function importDeck(userId: string, raw: string) {
	const parsed = parseAnkiExport(raw, userId);
	const warnings = [...parsed.warnings];
	// One INSERT cannot upsert the same id twice, so a repeated note (same GUID, or
	// identical content without one) would fail its whole batch. The last copy wins,
	// as it would have if the rows were imported one at a time.
	const byId = new Map<string, (typeof parsed.notes)[number]>();
	for (const n of parsed.notes) {
		if (byId.has(n.id))
			warnings.push(`Note repeated in the export: kept the last copy of ${n.id}.`);
		byId.delete(n.id);
		byId.set(n.id, n);
	}
	const notes = [...byId.values()];
	const excluded = (col: string) => sql.raw(`excluded.${col}`);
	// A savepoint inside the request's transaction (asTenant). A failed batch rolls
	// back the whole import, not a prefix of it, and leaves the request's transaction
	// usable, so the page load after the action's error still renders.
	await db.transaction(async (tx) => {
		for (let i = 0; i < notes.length; i += 500) {
			await tx
				.insert(table.node)
				.values(notes.slice(i, i + 500).map((n) => ({ ...n, userId })))
				.onConflictDoUpdate({
					target: table.node.id,
					set: {
						front: excluded('front'),
						back: excluded('back'),
						deck: excluded('deck'),
						tags: excluded('tags'),
						notetype: excluded('notetype')
					}
				});
		}
	});
	return { imported: notes.length, warnings };
}

/**
 * Delete a deck: its cards, their schedules and review history, and the deck's
 * rounds. A harvested link that became one of these cards goes back to review.
 * All or nothing (a savepoint inside the request). Returns the cards deleted.
 */
export async function deleteDeck(userId: string, deck: string): Promise<number> {
	return db.transaction(async (tx) => {
		const n = table.node;
		const ids = (
			await tx
				.select({ id: n.id })
				.from(n)
				// Cards only, as the deck page counts them. Other kinds that carry a deck
				// name (a Quest deck hall) belong to their own writers.
				.where(and(eq(n.userId, userId), eq(n.deck, deck), eq(n.kind, 'card')))
		).map((r) => r.id);
		const rounds = (
			await tx
				.select({ id: table.assessment.id })
				.from(table.assessment)
				.where(and(eq(table.assessment.userId, userId), eq(table.assessment.deck, deck)))
		).map((r) => r.id);
		if (ids.length === 0 && rounds.length === 0) return 0;

		const log = table.reviewLog;
		if (ids.length)
			await tx.delete(log).where(and(eq(log.userId, userId), inArray(log.nodeId, ids)));
		if (rounds.length)
			await tx.delete(log).where(and(eq(log.userId, userId), inArray(log.assessmentId, rounds)));
		if (ids.length) {
			await tx
				.delete(table.reviewState)
				.where(and(eq(table.reviewState.userId, userId), inArray(table.reviewState.nodeId, ids)));
			const e = table.edge;
			await tx
				.delete(e)
				.where(and(eq(e.userId, userId), or(inArray(e.srcId, ids), inArray(e.dstId, ids))));
			await tx
				.update(table.harvest)
				.set({ nodeId: null, status: 'ready' })
				.where(and(eq(table.harvest.userId, userId), inArray(table.harvest.nodeId, ids)));
			await tx
				.update(table.questRun)
				.set({ currentNodeId: null })
				.where(and(eq(table.questRun.userId, userId), inArray(table.questRun.currentNodeId, ids)));
		}
		if (rounds.length)
			await tx
				.delete(table.assessment)
				.where(and(eq(table.assessment.userId, userId), inArray(table.assessment.id, rounds)));
		if (ids.length) await tx.delete(n).where(and(eq(n.userId, userId), inArray(n.id, ids)));
		return ids.length;
	});
}

export async function listDecks(userId: string, now = new Date()) {
	const decks = await db
		.select({
			deck: table.node.deck,
			total: sql<number>`count(*)::int`,
			fresh: sql<number>`count(*) filter (where ${table.reviewState.nodeId} is null or ${table.reviewState.state} = 0)::int`,
			due: sql<number>`count(*) filter (where ${table.reviewState.state} != 0 and ${table.reviewState.due} <= ${now.toISOString()}::timestamptz)::int`
		})
		.from(table.node)
		.leftJoin(table.reviewState, eq(table.reviewState.nodeId, table.node.id))
		.where(and(eq(table.node.userId, userId), eq(table.node.kind, 'card')))
		.groupBy(table.node.deck)
		.orderBy(table.node.deck);

	// Only what the deck list shows: every finished round is returned, so keep rows narrow.
	const a = table.assessment;
	const history = await db
		.select({
			id: a.id,
			deck: a.deck,
			finishedAt: a.finishedAt,
			score: a.score,
			weak: a.weak,
			strong: a.strong
		})
		.from(table.assessment)
		.where(and(eq(table.assessment.userId, userId), isNotNull(table.assessment.finishedAt)))
		.orderBy(desc(table.assessment.finishedAt));

	return decks.map((d) => ({ ...d, assessments: history.filter((a) => a.deck === d.deck) }));
}

async function latestAssessment(userId: string, deck: string) {
	const [a] = await db
		.select()
		.from(table.assessment)
		.where(
			and(
				eq(table.assessment.userId, userId),
				eq(table.assessment.deck, deck),
				isNotNull(table.assessment.finishedAt)
			)
		)
		.orderBy(desc(table.assessment.finishedAt))
		.limit(1);
	return a ?? null;
}

// An unfinished round this recent is resumed on the next visit. Older ones are
// closed: graded if they hold any grades, deleted if they hold none.
const RESUME_WITHIN_MS = 12 * 60 * 60 * 1000;

/** Ratings logged so far in a round, per card, in attempt order. */
async function roundProgress(userId: string, assessmentId: string) {
	const logs = await db
		.select({ nodeId: table.reviewLog.nodeId, rating: table.reviewLog.rating })
		.from(table.reviewLog)
		.where(and(eq(table.reviewLog.userId, userId), eq(table.reviewLog.assessmentId, assessmentId)))
		.orderBy(asc(table.reviewLog.attempt), asc(table.reviewLog.id));
	const progress: Record<string, number[]> = {};
	for (const l of logs) (progress[l.nodeId] ??= []).push(l.rating);
	return progress;
}

/**
 * Open the study round for a deck: the unfinished one if it is recent, else a new
 * one. Loading the study page calls this, so it must be safe to repeat: a reload,
 * a second tab, or a link preload lands on the same round rather than opening
 * another and dropping the progress of the first.
 */
export async function startRound(userId: string, deck: string, now = new Date(), tz = 'UTC') {
	// Named columns, not the whole node: `embedding` alone is 1024 floats per card.
	const n = table.node;
	const rows = await db
		.select({
			node: { id: n.id, front: n.front, back: n.back, tags: n.tags },
			review: table.reviewState
		})
		.from(n)
		.leftJoin(table.reviewState, eq(table.reviewState.nodeId, n.id))
		.where(and(eq(n.userId, userId), eq(n.deck, deck), eq(n.kind, 'card')))
		.orderBy(asc(n.createdAt), asc(n.id));
	if (rows.length === 0) return null;
	const byId = new Map(rows.map((r) => [r.node.id, r]));
	const toCard = (id: string) => {
		const { node: n, review } = byId.get(id)!;
		return {
			id: n.id,
			front: n.front,
			back: n.back,
			tags: n.tags,
			preview: previewIntervals(review, now)
		};
	};

	const open = await db
		.select()
		.from(table.assessment)
		.where(
			and(
				eq(table.assessment.userId, userId),
				eq(table.assessment.deck, deck),
				isNull(table.assessment.finishedAt)
			)
		)
		.orderBy(desc(table.assessment.startedAt));
	// A card deleted by a re-import since the round opened is dropped from it.
	const live = (a: (typeof open)[number]) => a.cardIds.filter((id) => byId.has(id));
	const resumable = open.find(
		(a) => now.getTime() - a.startedAt.getTime() < RESUME_WITHIN_MS && live(a).length > 0
	);
	// Close every other open round, oldest first, so each one's standing builds on
	// the round before it. Only data from before rounds were resumable has several.
	for (const a of [...open].reverse()) if (a !== resumable) await closeStaleRound(userId, a.id);
	if (resumable) {
		const prior = await latestAssessment(userId, deck);
		return {
			assessmentId: resumable.id,
			prior: prior && { score: prior.score, weak: prior.weak, strong: prior.strong },
			cards: live(resumable).map(toCard),
			progress: await roundProgress(userId, resumable.id)
		};
	}

	const prior = await latestAssessment(userId, deck);
	const picked = selectRound(
		rows.map((r) => ({ id: r.node.id, tags: r.node.tags, review: r.review })),
		prior,
		now,
		ROUND_SIZE,
		NEW_PER_DAY - (await introducedToday(userId, deck, now, tz))
	);
	if (picked.length === 0) return null;

	const id = crypto.randomUUID();
	const cardIds = picked.map((p) => p.id);
	// Two loads at once (a double click, two tabs) must not both open a round. The
	// lock serializes openers of this deck; whoever loses finds the winner's round.
	const opened = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['round', userId, deck])}, 0))`
		);
		const [raced] = await tx
			.select({ id: table.assessment.id })
			.from(table.assessment)
			.where(
				and(
					eq(table.assessment.userId, userId),
					eq(table.assessment.deck, deck),
					isNull(table.assessment.finishedAt)
				)
			)
			.limit(1);
		if (raced) return false;
		await tx
			.insert(table.assessment)
			.values({ id, userId, deck, cardCount: cardIds.length, cardIds, startedAt: now });
		return true;
	});
	if (!opened) return startRound(userId, deck, now, tz);

	return {
		assessmentId: id,
		prior: prior && { score: prior.score, weak: prior.weak, strong: prior.strong },
		cards: cardIds.map(toCard),
		progress: {} as Record<string, number[]>
	};
}

/** Cards in the deck whose first ever review fell on today, in time zone `tz`. */
async function introducedToday(userId: string, deck: string, now: Date, tz: string) {
	const [{ n }] = await db
		.select({ n: sql<number>`count(distinct ${table.reviewLog.nodeId})::int` })
		.from(table.reviewLog)
		.innerJoin(table.node, eq(table.node.id, table.reviewLog.nodeId))
		.where(
			and(
				eq(table.reviewLog.userId, userId),
				eq(table.reviewLog.state, 0),
				sql`(${table.reviewLog.reviewedAt} at time zone ${tz})::date = (${now.toISOString()}::timestamptz at time zone ${tz})::date`,
				eq(table.node.deck, deck)
			)
		);
	return n;
}

/** Grade an abandoned round on what it has, or delete it if nothing was graded. */
async function closeStaleRound(userId: string, assessmentId: string) {
	const [last] = await db
		.select({ at: table.reviewLog.reviewedAt })
		.from(table.reviewLog)
		.where(and(eq(table.reviewLog.userId, userId), eq(table.reviewLog.assessmentId, assessmentId)))
		.orderBy(desc(table.reviewLog.reviewedAt))
		.limit(1);
	if (last) await finishRound(userId, assessmentId, last.at);
	else
		await db
			.delete(table.assessment)
			.where(and(eq(table.assessment.id, assessmentId), eq(table.assessment.userId, userId)));
}

async function ownedOpenAssessment(userId: string, assessmentId: string) {
	const [a] = await db
		.select()
		.from(table.assessment)
		.where(and(eq(table.assessment.id, assessmentId), eq(table.assessment.userId, userId)));
	return a && !a.finishedAt ? a : null;
}

/**
 * Grade one attempt at a card in an open round. Returns the rating stored for
 * that attempt, which differs from `rating` when the attempt was already logged
 * (a retried request): the first write wins, and the caller should act on what
 * was stored. Null when the round, card or attempt is not valid.
 */
export async function recordGrade(
	userId: string,
	assessmentId: string,
	nodeId: string,
	rating: Grade,
	attempt: number,
	now = new Date()
): Promise<number | null> {
	const a = await ownedOpenAssessment(userId, assessmentId);
	if (!a || !a.cardIds.includes(nodeId)) return null;
	return db.transaction(async (tx) => {
		// Lock the card so two tabs grading it at once cannot both read the same state.
		const [row] = await tx
			.select({ id: table.node.id, review: table.reviewState })
			.from(table.node)
			.leftJoin(table.reviewState, eq(table.reviewState.nodeId, table.node.id))
			.where(
				and(eq(table.node.id, nodeId), eq(table.node.userId, userId), eq(table.node.deck, a.deck))
			)
			.for('update', { of: table.node });
		if (!row) return null;

		const prior = await tx
			.select({ rating: table.reviewLog.rating })
			.from(table.reviewLog)
			.where(
				and(eq(table.reviewLog.assessmentId, assessmentId), eq(table.reviewLog.nodeId, nodeId))
			)
			.orderBy(asc(table.reviewLog.attempt));
		// A retry of an attempt already logged: report it, change nothing.
		if (attempt < prior.length) return prior[attempt].rating;
		// Attempts come in order, and a repeat follows only a miss.
		if (attempt > prior.length || (attempt > 0 && prior[attempt - 1].rating !== 1)) return null;

		const { next, elapsedDays, priorState } = grade(row.review, rating, now);
		await tx.insert(table.reviewLog).values({
			userId,
			nodeId,
			rating,
			state: priorState,
			elapsedDays,
			reviewedAt: now,
			surface: 'cards',
			assessmentId,
			attempt
		});
		await tx
			.insert(table.reviewState)
			.values({ nodeId, userId, ...next })
			.onConflictDoUpdate({ target: table.reviewState.nodeId, set: next });
		return rating;
	});
}

/**
 * Writes the grading artifact. The score and areas come from each card's first
 * attempt in this round; weak and strong come from the standing carried forward
 * from the deck's previous round plus this one.
 */
export async function finishRound(userId: string, assessmentId: string, now = new Date()) {
	const a = await ownedOpenAssessment(userId, assessmentId);
	if (!a) return null;

	const logs = await db
		.select({
			nodeId: table.reviewLog.nodeId,
			rating: table.reviewLog.rating,
			tags: table.node.tags
		})
		.from(table.reviewLog)
		.innerJoin(table.node, eq(table.node.id, table.reviewLog.nodeId))
		.where(and(eq(table.reviewLog.userId, userId), eq(table.reviewLog.assessmentId, assessmentId)))
		.orderBy(asc(table.reviewLog.id));

	const first = new Map<string, { tags: string[]; rating: number }>();
	for (const l of logs) if (!first.has(l.nodeId)) first.set(l.nodeId, l);

	const round = gradeRound([...first.values()]);
	const standing = mergeStanding(standingOf(await latestAssessment(userId, a.deck)), round.areas);
	const g = { ...round, ...classify(standing) };
	await db
		.update(table.assessment)
		.set({
			finishedAt: now,
			score: g.score,
			areas: g.areas,
			standing,
			strong: g.strong,
			weak: g.weak
		})
		.where(eq(table.assessment.id, assessmentId));
	return g;
}

/** Interval labels for a card's next rating, from its stored state. */
export async function cardPreview(userId: string, nodeId: string, now = new Date()) {
	const [review] = await db
		.select()
		.from(table.reviewState)
		.where(and(eq(table.reviewState.nodeId, nodeId), eq(table.reviewState.userId, userId)));
	return previewIntervals(review ?? null, now);
}
