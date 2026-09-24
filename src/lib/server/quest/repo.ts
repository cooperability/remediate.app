import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Grade } from 'ts-fsrs';
import { db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { newLeftByDeck } from '$lib/server/cards/budget';
import { plainText } from '$lib/server/cards/browse';
import { writeReview, type Tx } from '$lib/server/cards/review';
import { retrievability } from '$lib/server/cards/scheduler';
import { NEW_PER_DAY } from '$lib/server/cards/select';
import {
	CLEAR_SHARE,
	type EncounterCard,
	type Facet,
	type Outcome,
	type QuestView
} from '$lib/quest/types';
import {
	approach,
	buildMap,
	buildWorld,
	checkEncounter,
	checkMove,
	clearedBy,
	describeRoom,
	entrance,
	gate,
	holdOf,
	knows,
	suggest,
	type Ctx,
	type Memory,
	type MoveCheck,
	type Run,
	type WorldNode
} from './engine';
import { deriveImportGraph, escapeHtml } from './graph';
import { cachedLayout } from './layout';

// Quest's I/O. The rules live in engine.ts; this file loads a world for them,
// persists where the player stands (PRD QST-4), and grades encounters through
// the same write path as Cards (QST-3).
//
// Locking. Every Quest writer, and importDeck, takes questLock(userId) first,
// then the run row, then a card row. One order everywhere: an import locks card
// rows and its graph sync can reach the run row (a deleted concept sets
// current_node_id null), so without the shared first lock an import and an
// encounter grade deadlock. Rules are always evaluated on a world loaded after
// the lock, never on one read before it.

/** What quest_runs.state holds. */
export interface RunState {
	/** The encounter on offer: one at a time, so a double tap cannot open two. */
	encounter?: { id: string; nodeId: string; openedAt: string };
}

/** Concept nodes the import owns. Enrichment's concepts (Phase 5) carry another notetype. */
const IMPORT_FACETS = ['deck', 'tag'];

/** Title length on the map and in door lists. */
const TITLE_CHARS = 90;

/** The per-user lock every Quest writer takes first. See the file comment. */
export const questLock = (userId: string) =>
	sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['quest', userId])}, 0))`;

/**
 * Bring the user's deck and tag concepts, and the import edges to them, in line
 * with their cards and harvested documents. Idempotent and read-only when
 * nothing changed, so it runs after every import and on every /quest load: the
 * seed script and any other writer of cards cannot leave the map stale.
 *
 * Ownership: this owns edges with provenance 'import' and concept nodes with
 * notetype deck or tag. It never deletes a concept that another writer
 * (enrichment, BMX, a person) has an edge to, since the cascade would take that
 * edge with it.
 */
export async function syncImportGraph(userId: string) {
	return db.transaction(async (tx) => {
		await tx.execute(questLock(userId));
		return syncImportGraphIn(tx, userId);
	});
}

/** syncImportGraph inside a transaction that already holds questLock. */
export async function syncImportGraphIn(tx: Tx, userId: string) {
	const facts = await tx
		.select({ id: table.node.id, deck: table.node.deck, tags: table.node.tags })
		.from(table.node)
		.where(and(eq(table.node.userId, userId), inArray(table.node.kind, ['card', 'doc'])));
	const want = deriveImportGraph(userId, facts);

	const have = await tx
		.select({
			id: table.node.id,
			front: table.node.front,
			deck: table.node.deck,
			notetype: table.node.notetype
		})
		.from(table.node)
		.where(
			and(
				eq(table.node.userId, userId),
				eq(table.node.kind, 'concept'),
				inArray(table.node.notetype, IMPORT_FACETS)
			)
		);
	const haveById = new Map(have.map((h) => [h.id, h]));
	const upserts = want.concepts
		.map((c) => ({
			id: c.id,
			userId,
			kind: 'concept',
			notetype: c.facet,
			front: escapeHtml(c.name),
			deck: c.deck
		}))
		.filter((c) => {
			const h = haveById.get(c.id);
			return !h || h.front !== c.front || h.deck !== c.deck || h.notetype !== c.notetype;
		});
	for (let i = 0; i < upserts.length; i += 500) {
		await tx
			.insert(table.node)
			.values(upserts.slice(i, i + 500))
			.onConflictDoUpdate({
				target: table.node.id,
				set: {
					front: sql.raw('excluded.front'),
					deck: sql.raw('excluded.deck'),
					notetype: sql.raw('excluded.notetype')
				},
				// An id held by anything but an import concept is not ours to rewrite.
				setWhere: and(eq(table.node.kind, 'concept'), inArray(table.node.notetype, IMPORT_FACETS))
			});
	}

	const edgeKey = (e: { srcId: string; dstId: string; kind: string }) =>
		`${e.srcId}\u0000${e.dstId}\u0000${e.kind}`;
	const existing = await tx
		.select({
			id: table.edge.id,
			srcId: table.edge.srcId,
			dstId: table.edge.dstId,
			kind: table.edge.kind
		})
		.from(table.edge)
		.where(and(eq(table.edge.userId, userId), eq(table.edge.provenance, 'import')));
	const wanted = new Set(want.edges.map(edgeKey));
	const present = new Set(existing.map(edgeKey));
	const stale = existing.filter((e) => !wanted.has(edgeKey(e))).map((e) => e.id);
	const missing = want.edges.filter((e) => !present.has(edgeKey(e)));
	for (let i = 0; i < stale.length; i += 1000) {
		await tx.delete(table.edge).where(inArray(table.edge.id, stale.slice(i, i + 1000)));
	}
	for (let i = 0; i < missing.length; i += 1000) {
		await tx
			.insert(table.edge)
			.values(
				missing.slice(i, i + 1000).map((e) => ({ ...e, userId, weight: 1, provenance: 'import' }))
			)
			.onConflictDoNothing();
	}

	// A tag or deck nothing carries any more goes, unless another writer links to
	// it. Its import edges cascade, and a run standing on it is set back to the
	// entrance (schema.ts foreign keys; this transaction already holds questLock).
	const keep = new Set(want.concepts.map((c) => c.id));
	let gone = have.filter((h) => !keep.has(h.id)).map((h) => h.id);
	if (gone.length) {
		const held = await tx
			.selectDistinct({ src: table.edge.srcId, dst: table.edge.dstId })
			.from(table.edge)
			.where(
				and(
					eq(table.edge.userId, userId),
					ne(table.edge.provenance, 'import'),
					or(inArray(table.edge.srcId, gone), inArray(table.edge.dstId, gone))
				)
			);
		const linked = new Set(held.flatMap((h) => [h.src, h.dst]));
		gone = gone.filter((id) => !linked.has(id));
	}
	if (gone.length) await tx.delete(table.node).where(inArray(table.node.id, gone));
	return {
		concepts: upserts.length,
		removed: gone.length,
		edgesAdded: missing.length,
		edgesRemoved: stale.length
	};
}

interface Loaded {
	ctx: Ctx;
	layout: ReturnType<typeof cachedLayout>;
}

const FACETS: Record<string, Facet> = { deck: 'deck', tag: 'tag' };

/** Everything the rules read, for one user, at `now`. */
async function loadWorld(userId: string, now: Date, tz: string): Promise<Loaded> {
	const n = table.node;
	const [nodes, edges, states, newLeft] = await Promise.all([
		db
			.select({
				id: n.id,
				kind: n.kind,
				notetype: n.notetype,
				deck: n.deck,
				// Fronts reach 48k characters; a 90-character title needs a few hundred.
				front: sql<string>`left(${n.front}, 400)`
			})
			.from(n)
			.where(and(eq(n.userId, userId), inArray(n.kind, ['card', 'concept']))),
		db
			.select({ srcId: table.edge.srcId, dstId: table.edge.dstId, kind: table.edge.kind })
			.from(table.edge)
			.where(eq(table.edge.userId, userId)),
		db.select().from(table.reviewState).where(eq(table.reviewState.userId, userId)),
		newLeftByDeck(userId, now, tz)
	]);

	const worldNodes: WorldNode[] = nodes.map((r) => ({
		id: r.id,
		// Import concepts are decks and tags; anything else (enrichment's) is a concept.
		facet: r.kind === 'card' ? 'card' : (FACETS[r.notetype] ?? 'concept'),
		deck: r.deck,
		title: plainText(r.front, TITLE_CHARS) || '(blank)',
		weight: 1
	}));
	const world = buildWorld(worldNodes, edges);
	const memory = new Map<string, Memory>();
	for (const s of states) memory.set(s.nodeId, memoryOf(s, now));
	// Decks with nothing introduced today have their whole allowance.
	const left = new Map<string, number>();
	for (const node of world.nodes.values()) {
		if (node.facet === 'card' && !left.has(node.deck))
			left.set(node.deck, newLeft.get(node.deck) ?? NEW_PER_DAY);
	}
	return {
		ctx: { world, memory, now, newLeft: left },
		layout: cachedLayout(userId, world)
	};
}

function memoryOf(s: table.ReviewState, now: Date): Memory {
	return { stability: s.stability, state: s.state, due: s.due, strength: retrievability(s, now) };
}

type RunRow = typeof table.questRun.$inferSelect;
type Locked = { row: RunRow; run: Run; state: RunState };

/**
 * The user's run, locked FOR UPDATE. Created at the entrance on first visit,
 * and moved back there if the node it stood on is gone (a pending encounter
 * goes with it: it was opened from somewhere that no longer exists). Null when
 * the world has no decks yet.
 */
async function lockRun(tx: Tx, userId: string, ctx: Ctx): Promise<Locked | null> {
	const select = () =>
		tx.select().from(table.questRun).where(eq(table.questRun.userId, userId)).for('update');
	let [row]: (RunRow | undefined)[] = await select();
	const start = entrance(ctx);
	if (!start) return null;
	if (!row) {
		await tx
			.insert(table.questRun)
			.values({ id: crypto.randomUUID(), userId, currentNodeId: start, visited: [start] })
			.onConflictDoNothing({ target: table.questRun.userId });
		[row] = await select();
	}
	if (!row.currentNodeId || !ctx.world.nodes.has(row.currentNodeId)) {
		[row] = await tx
			.update(table.questRun)
			.set({ currentNodeId: start, visited: [...new Set([...row.visited, start])], state: {} })
			.where(eq(table.questRun.id, row.id))
			.returning();
	}
	const run: Run = {
		current: row.currentNodeId!,
		visited: new Set(row.visited.filter((id) => ctx.world.nodes.has(id)))
	};
	return { row, run, state: (row.state ?? {}) as RunState };
}

/** Lock, then load, then lock the run: the order every writer below follows. */
async function locked<T>(
	userId: string,
	now: Date,
	tz: string,
	fn: (tx: Tx, loaded: Loaded, r: Locked) => Promise<T>,
	empty: T
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(questLock(userId));
		const loaded = await loadWorld(userId, now, tz);
		const r = await lockRun(tx, userId, loaded.ctx);
		return r ? fn(tx, loaded, r) : empty;
	});
}

async function cardHtml(userId: string, id: string) {
	const [c] = await db
		.select({
			front: table.node.front,
			back: table.node.back,
			tags: table.node.tags,
			deck: table.node.deck
		})
		.from(table.node)
		.where(and(eq(table.node.id, id), eq(table.node.userId, userId), eq(table.node.kind, 'card')));
	return c ?? null;
}

/** The calendar day `date` falls on in time zone `tz`. */
function dayIn(date: Date, tz: string) {
	return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

/**
 * The run's pending encounter, if it is still valid: the door still offers an
 * encounter from where the player stands, and it was opened today. An
 * encounter from yesterday was opened against yesterday's allowance.
 */
function livePending(ctx: Ctx, run: Run, state: RunState, tz: string) {
	const p = state.encounter;
	if (!p) return null;
	if (dayIn(new Date(p.openedAt), tz) !== dayIn(ctx.now, tz)) return null;
	return checkEncounter(ctx, run, p.nodeId) === 'ok' ? p : null;
}

async function viewOf(
	userId: string,
	loaded: Loaded,
	run: Run,
	state: RunState,
	tz: string
): Promise<QuestView> {
	const { ctx, layout } = loaded;
	const room = describeRoom(ctx, run);
	if (room.facet === 'card') {
		const c = await cardHtml(userId, room.id);
		if (c) Object.assign(room, { front: c.front, back: c.back, tags: c.tags });
	}
	const pending = livePending(ctx, run, state, tz);
	const encounter = pending && (await encounterCard(userId, ctx, pending.id, pending.nodeId));
	return { room, map: buildMap(ctx, run, layout), encounter, next: suggest(ctx, run) };
}

async function encounterCard(
	userId: string,
	ctx: Ctx,
	encounterId: string,
	nodeId: string
): Promise<EncounterCard | null> {
	const c = await cardHtml(userId, nodeId);
	if (!c) return null;
	const m = ctx.memory.get(nodeId);
	return {
		encounterId,
		nodeId,
		front: c.front,
		back: c.back,
		tags: c.tags,
		fresh: !m || m.state === 0,
		review: !!gate(ctx, nodeId).due
	};
}

/** The player's current view: room, map, next step, and any encounter left open. Null before any import. */
export async function questView(userId: string, now = new Date(), tz = 'UTC') {
	return locked<QuestView | null>(
		userId,
		now,
		tz,
		(_tx, loaded, r) => viewOf(userId, loaded, r.run, r.state, tz),
		null
	);
}

export type MoveResult = { ok: true; view: QuestView } | { ok: false; reason: MoveCheck | 'empty' };

/** Step through an open door, or fast-travel to a node the map shows. */
export async function move(
	userId: string,
	to: string,
	now = new Date(),
	tz = 'UTC'
): Promise<MoveResult> {
	return locked<MoveResult>(
		userId,
		now,
		tz,
		async (tx, loaded, r) => {
			const check = checkMove(loaded.ctx, r.run, to);
			if (check === 'here')
				return { ok: true, view: await viewOf(userId, loaded, r.run, r.state, tz) };
			if (check !== 'ok') return { ok: false, reason: check };
			const visited = r.run.visited.has(to) ? [...r.run.visited] : [...r.run.visited, to];
			// Walking away from an encounter abandons it.
			const state: RunState = { ...r.state, encounter: undefined };
			await tx
				.update(table.questRun)
				.set({ currentNodeId: to, visited, state })
				.where(eq(table.questRun.id, r.row.id));
			const run: Run = { current: to, visited: new Set(visited) };
			return { ok: true, view: await viewOf(userId, loaded, run, state, tz) };
		},
		{ ok: false, reason: 'empty' }
	);
}

export type EncounterResult =
	| { ok: true; encounter: EncounterCard; view?: QuestView }
	| { ok: false; reason: MoveCheck | 'empty' | 'none' };

async function open(
	tx: Tx,
	userId: string,
	loaded: Loaded,
	r: Locked,
	to: string,
	tz: string
): Promise<EncounterResult> {
	const check = checkEncounter(loaded.ctx, r.run, to);
	if (check !== 'ok') return { ok: false, reason: check };
	let pending = livePending(loaded.ctx, r.run, r.state, tz);
	if (pending?.nodeId !== to) {
		pending = { id: crypto.randomUUID(), nodeId: to, openedAt: loaded.ctx.now.toISOString() };
		r.state = { ...r.state, encounter: pending };
		await tx.update(table.questRun).set({ state: r.state }).where(eq(table.questRun.id, r.row.id));
	}
	const card = await encounterCard(userId, loaded.ctx, pending.id, to);
	return card ? { ok: true, encounter: card } : { ok: false, reason: 'unknown-node' };
}

/**
 * Try a door: a locked one (a first meeting or a rematch) or an open card that
 * is due (a review). The card behind it becomes the encounter. Opening the same
 * door twice returns the same encounter, so a double tap is harmless.
 */
export async function openEncounter(
	userId: string,
	to: string,
	now = new Date(),
	tz = 'UTC'
): Promise<EncounterResult> {
	return locked<EncounterResult>(
		userId,
		now,
		tz,
		(tx, loaded, r) => open(tx, userId, loaded, r, to, tz),
		{ ok: false, reason: 'empty' }
	);
}

/**
 * The next encounter worth having (engine.suggest), anywhere on the map: walk to
 * a room with a door to it, then open it. Returns the view from there too.
 */
export async function nextEncounter(
	userId: string,
	now = new Date(),
	tz = 'UTC'
): Promise<EncounterResult> {
	return locked<EncounterResult>(
		userId,
		now,
		tz,
		async (tx, loaded, r) => {
			const s = suggest(loaded.ctx, r.run);
			if (!s) return { ok: false, reason: 'none' };
			const from = approach(loaded.ctx, r.run, s.to);
			if (!from) return { ok: false, reason: 'unreachable' };
			if (from !== r.run.current) {
				const visited = r.run.visited.has(from) ? [...r.run.visited] : [...r.run.visited, from];
				r.run = { current: from, visited: new Set(visited) };
				r.state = { ...r.state, encounter: undefined };
				await tx
					.update(table.questRun)
					.set({ currentNodeId: from, visited, state: r.state })
					.where(eq(table.questRun.id, r.row.id));
			}
			const opened = await open(tx, userId, loaded, r, s.to, tz);
			if (!opened.ok) return opened;
			return { ...opened, view: await viewOf(userId, loaded, r.run, r.state, tz) };
		},
		{ ok: false, reason: 'empty' }
	);
}

export type GradeResult = Outcome | { refused: MoveCheck | 'stale' } | null;

/**
 * Grade the open encounter. The review goes through writeReview with surface
 * 'quest' (QST-3). Under the lock, the door is checked again: an encounter
 * opened before a Cards round graded the same card, before today's allowance
 * ran out, or on another day, is refused rather than graded. If the card is
 * known afterwards, the player steps into its room in the same transaction. A
 * retried request (same encounterId) is reported from the log, never graded
 * twice. Null when no such encounter was ever opened.
 */
export async function gradeEncounter(
	userId: string,
	encounterId: string,
	nodeId: string,
	rating: Grade,
	now = new Date(),
	tz = 'UTC'
): Promise<GradeResult> {
	return locked<GradeResult>(
		userId,
		now,
		tz,
		async (tx, loaded, r) => {
			const { ctx } = loaded;
			const [logged] = await tx
				.select({ rating: table.reviewLog.rating, nodeId: table.reviewLog.nodeId })
				.from(table.reviewLog)
				.where(
					and(eq(table.reviewLog.userId, userId), eq(table.reviewLog.encounterId, encounterId))
				);
			if (logged) {
				if (logged.nodeId !== nodeId) return null;
				const m = ctx.memory.get(nodeId);
				// The stability before the first grade is not kept, so a retry reports
				// where the lock stands without the movement.
				return {
					rating: logged.rating,
					unlocked: knows(m),
					...(knows(m)
						? {}
						: { retryAt: m?.due.toISOString(), hold: { before: holdOf(m), after: holdOf(m) } })
				};
			}

			const pending = r.state.encounter;
			if (pending?.id !== encounterId || pending.nodeId !== nodeId) return null;

			// Lock the card, as Cards does, and judge the door on its state under the lock.
			const [card] = await tx
				.select({ id: table.node.id, review: table.reviewState })
				.from(table.node)
				.leftJoin(table.reviewState, eq(table.reviewState.nodeId, table.node.id))
				.where(
					and(eq(table.node.id, nodeId), eq(table.node.userId, userId), eq(table.node.kind, 'card'))
				)
				.for('update', { of: table.node });
			if (!card) return null;
			const before = card.review ? memoryOf(card.review, now) : undefined;
			if (before) ctx.memory.set(nodeId, before);
			else ctx.memory.delete(nodeId);
			if (!livePending(ctx, r.run, r.state, tz)) {
				await tx
					.update(table.questRun)
					.set({ state: { ...r.state, encounter: undefined } })
					.where(eq(table.questRun.id, r.row.id));
				const check = checkEncounter(ctx, r.run, nodeId);
				return { refused: check === 'ok' ? 'stale' : check };
			}
			const review = !!gate(ctx, nodeId).due;

			const next = await writeReview(tx, {
				userId,
				nodeId,
				review: card.review,
				rating,
				now,
				surface: 'quest',
				encounterId
			});
			const after = memoryOf({ ...next, nodeId, userId }, now);
			const unlocked = knows(after);
			const cleared = clearedBy(ctx, nodeId, before, after, CLEAR_SHARE);
			const state: RunState = { ...r.state, encounter: undefined };
			const visited = r.row.visited.includes(nodeId) ? r.row.visited : [...r.row.visited, nodeId];
			await tx
				.update(table.questRun)
				.set(unlocked ? { state, currentNodeId: nodeId, visited } : { state })
				.where(eq(table.questRun.id, r.row.id));
			return {
				rating,
				unlocked,
				...(review ? { review: true } : {}),
				...(unlocked
					? {}
					: {
							retryAt: next.due.toISOString(),
							hold: { before: holdOf(before), after: holdOf(after) }
						}),
				...(cleared.length ? { cleared } : {})
			};
		},
		null
	);
}
