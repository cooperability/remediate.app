import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Grade } from 'ts-fsrs';
import { db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { newLeftByDeck } from '$lib/server/cards/budget';
import { plainText } from '$lib/server/cards/browse';
import { writeReview, type Tx } from '$lib/server/cards/review';
import { retrievability } from '$lib/server/cards/scheduler';
import { NEW_PER_DAY } from '$lib/server/cards/select';
import {
	DOOR_THRESHOLD,
	type EncounterCard,
	type Facet,
	type Outcome,
	type QuestView
} from '$lib/quest/types';
import {
	buildMap,
	buildWorld,
	checkEncounter,
	checkMove,
	describeRoom,
	entrance,
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

/** What quest_runs.state holds. */
export interface RunState {
	/** The encounter on offer: one at a time, so a double tap cannot open two. */
	encounter?: { id: string; nodeId: string; openedAt: string };
}

/** Concept nodes the import owns. Enrichment's concepts (Phase 5) will carry another notetype. */
const IMPORT_FACETS = ['deck', 'tag'];

/** Title length on the map and in door lists. */
const TITLE_CHARS = 90;

const lock = (key: unknown[]) =>
	sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;

/**
 * Bring the user's deck and tag concepts, and the import edges to them, in line
 * with their cards. Idempotent and cheap when nothing changed (reads only), so
 * it runs after every import and on every /quest load: the seed script and any
 * other writer of cards cannot leave the map stale.
 */
export async function syncImportGraph(userId: string) {
	return db.transaction(async (tx) => {
		// Two tabs loading /quest at once would race on the same inserts.
		await tx.execute(lock(['quest-sync', userId]));
		const cards = await tx
			.select({ id: table.node.id, deck: table.node.deck, tags: table.node.tags })
			.from(table.node)
			.where(and(eq(table.node.userId, userId), eq(table.node.kind, 'card')));
		const want = deriveImportGraph(userId, cards);

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
					}
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

		// A tag no card carries any more: its concept goes. Its edges cascade, and a
		// run standing on it is set back to the entrance (schema.ts foreign keys).
		const keep = new Set(want.concepts.map((c) => c.id));
		const gone = have.filter((h) => !keep.has(h.id)).map((h) => h.id);
		if (gone.length) await tx.delete(table.node).where(inArray(table.node.id, gone));
		return {
			concepts: upserts.length,
			removed: gone.length,
			edgesAdded: missing.length,
			edgesRemoved: stale.length
		};
	});
}

interface Loaded {
	ctx: Ctx;
	layout: ReturnType<typeof cachedLayout>;
}

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
				// Fronts reach 48k characters. A title needs the first few hundred.
				front: sql<string>`left(${n.front}, 2000)`
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
		facet: (r.kind === 'card' ? 'card' : r.notetype === 'deck' ? 'deck' : 'tag') as Facet,
		deck: r.deck,
		title: plainText(r.front, TITLE_CHARS) || '(blank)',
		weight: 1
	}));
	const world = buildWorld(worldNodes, edges);
	for (const node of world.nodes.values()) {
		if (node.facet !== 'card') {
			node.weight = (world.links.get(node.id) ?? []).filter(
				(l) => world.nodes.get(l.to)?.facet === 'card'
			).length;
		}
	}
	const memory = new Map<string, Memory>();
	for (const s of states) {
		memory.set(s.nodeId, {
			stability: s.stability,
			state: s.state,
			due: s.due,
			strength: retrievability(s, now)
		});
	}
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

type RunRow = typeof table.questRun.$inferSelect;

/**
 * The user's run, locked FOR UPDATE so moves, encounters and grades on one run
 * are serialized. Created at the entrance on first visit, and moved back there
 * if the node it stood on is gone. Null when the world has no decks yet.
 */
async function lockRun(tx: Tx, userId: string, ctx: Ctx) {
	const select = () =>
		tx.select().from(table.questRun).where(eq(table.questRun.userId, userId)).for('update');
	let [row]: (RunRow | undefined)[] = await select();
	const start = entrance(ctx.world);
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
			.set({ currentNodeId: start, visited: [...new Set([...row.visited, start])] })
			.where(eq(table.questRun.id, row.id))
			.returning();
	}
	const run: Run = {
		current: row.currentNodeId!,
		visited: new Set(row.visited.filter((id) => ctx.world.nodes.has(id)))
	};
	return { row, run, state: (row.state ?? {}) as RunState };
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

async function viewOf(
	userId: string,
	loaded: Loaded,
	run: Run,
	state: RunState
): Promise<QuestView> {
	const { ctx, layout } = loaded;
	const room = describeRoom(ctx, run);
	if (room.facet === 'card') {
		const c = await cardHtml(userId, room.id);
		if (c) Object.assign(room, { front: c.front, back: c.back, tags: c.tags });
	}
	let encounter: EncounterCard | null = null;
	const pending = state.encounter;
	// Offer a pending encounter again only while it is still a locked door from here.
	if (pending && checkEncounter(ctx, run, pending.nodeId) === 'ok') {
		encounter = await encounterCard(userId, ctx, pending.id, pending.nodeId);
	}
	return { room, map: buildMap(ctx, run, layout), encounter };
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
		fresh: !m || m.state === 0
	};
}

/** The player's current view: room, map, and any encounter left open. Null before any import. */
export async function questView(userId: string, now = new Date(), tz = 'UTC') {
	const loaded = await loadWorld(userId, now, tz);
	return db.transaction(async (tx) => {
		const r = await lockRun(tx, userId, loaded.ctx);
		return r && viewOf(userId, loaded, r.run, r.state);
	});
}

export type MoveResult = { ok: true; view: QuestView } | { ok: false; reason: MoveCheck | 'empty' };

/** Step through an open door, or fast-travel to a node the map shows. */
export async function move(
	userId: string,
	to: string,
	now = new Date(),
	tz = 'UTC'
): Promise<MoveResult> {
	const loaded = await loadWorld(userId, now, tz);
	return db.transaction(async (tx) => {
		const r = await lockRun(tx, userId, loaded.ctx);
		if (!r) return { ok: false, reason: 'empty' };
		const check = checkMove(loaded.ctx, r.run, to);
		if (check === 'here') return { ok: true, view: await viewOf(userId, loaded, r.run, r.state) };
		if (check !== 'ok') return { ok: false, reason: check };
		const visited = r.run.visited.has(to) ? [...r.run.visited] : [...r.run.visited, to];
		// Walking away from an encounter abandons it.
		const state: RunState = { ...r.state, encounter: undefined };
		await tx
			.update(table.questRun)
			.set({ currentNodeId: to, visited, state })
			.where(eq(table.questRun.id, r.row.id));
		const run: Run = { current: to, visited: new Set(visited) };
		return { ok: true, view: await viewOf(userId, loaded, run, state) };
	});
}

export type EncounterResult =
	{ ok: true; encounter: EncounterCard } | { ok: false; reason: MoveCheck | 'empty' };

/**
 * Try a locked door: the card behind it becomes the encounter. Opening the same
 * door twice returns the same encounter, so a double tap is harmless.
 */
export async function openEncounter(
	userId: string,
	to: string,
	now = new Date(),
	tz = 'UTC'
): Promise<EncounterResult> {
	const loaded = await loadWorld(userId, now, tz);
	return db.transaction(async (tx) => {
		const r = await lockRun(tx, userId, loaded.ctx);
		if (!r) return { ok: false, reason: 'empty' };
		const check = checkEncounter(loaded.ctx, r.run, to);
		if (check !== 'ok') return { ok: false, reason: check };
		let pending = r.state.encounter;
		if (pending?.nodeId !== to) {
			pending = { id: crypto.randomUUID(), nodeId: to, openedAt: now.toISOString() };
			await tx
				.update(table.questRun)
				.set({ state: { ...r.state, encounter: pending } })
				.where(eq(table.questRun.id, r.row.id));
		}
		const card = await encounterCard(userId, loaded.ctx, pending.id, to);
		return card ? { ok: true, encounter: card } : { ok: false, reason: 'unknown-node' };
	});
}

export type EncounterGrade = Outcome;

/**
 * Grade the open encounter. The review goes through writeReview with surface
 * 'quest' (QST-3). If the card's stability now clears the door, the player walks
 * through it in the same transaction. A retried request (same encounterId) is
 * reported from the log, never graded twice. Null when no such encounter is open.
 */
export async function gradeEncounter(
	userId: string,
	encounterId: string,
	nodeId: string,
	rating: Grade,
	now = new Date()
): Promise<EncounterGrade | null> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(table.questRun)
			.where(eq(table.questRun.userId, userId))
			.for('update');
		if (!row) return null;

		const [logged] = await tx
			.select({ rating: table.reviewLog.rating, nodeId: table.reviewLog.nodeId })
			.from(table.reviewLog)
			.where(and(eq(table.reviewLog.userId, userId), eq(table.reviewLog.encounterId, encounterId)));
		if (logged) {
			if (logged.nodeId !== nodeId) return null;
			const [s] = await tx
				.select({ stability: table.reviewState.stability, due: table.reviewState.due })
				.from(table.reviewState)
				.where(eq(table.reviewState.nodeId, nodeId));
			const unlocked = (s?.stability ?? 0) >= DOOR_THRESHOLD;
			return {
				rating: logged.rating,
				unlocked,
				retryAt: unlocked ? undefined : s?.due.toISOString()
			};
		}

		const state = (row.state ?? {}) as RunState;
		if (state.encounter?.id !== encounterId || state.encounter.nodeId !== nodeId) return null;

		// Lock the card, as Cards does, so a round grading it at the same moment waits.
		const [card] = await tx
			.select({ id: table.node.id, review: table.reviewState })
			.from(table.node)
			.leftJoin(table.reviewState, eq(table.reviewState.nodeId, table.node.id))
			.where(
				and(eq(table.node.id, nodeId), eq(table.node.userId, userId), eq(table.node.kind, 'card'))
			)
			.for('update', { of: table.node });
		if (!card) return null;

		const next = await writeReview(tx, {
			userId,
			nodeId,
			review: card.review,
			rating,
			now,
			surface: 'quest',
			encounterId
		});
		const unlocked = next.stability >= DOOR_THRESHOLD;
		const nextState: RunState = { ...state, encounter: undefined };
		await tx
			.update(table.questRun)
			.set(
				unlocked
					? {
							state: nextState,
							currentNodeId: nodeId,
							visited: row.visited.includes(nodeId) ? row.visited : [...row.visited, nodeId]
						}
					: { state: nextState }
			)
			.where(eq(table.questRun.id, row.id));
		return { rating, unlocked, retryAt: unlocked ? undefined : next.due.toISOString() };
	});
}
