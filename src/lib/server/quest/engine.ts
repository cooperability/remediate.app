import {
	DOOR_THRESHOLD,
	type Door,
	type Facet,
	type Gate,
	type MapNode,
	type MapView,
	type Room,
	type Suggestion
} from '$lib/quest/types';

// The Quest rules (TDD §9). Pure: the world, the player's memory of it and the
// clock come in; rooms, doors and the map come out. repo.ts does all the I/O,
// so every rule here is a table test.
//
// One rule carries the product: a door into a card is open iff that card's FSRS
// stability is at least DOOR_THRESHOLD (PRD QST-2). The scheduler's memory model
// is the game's progression system. Decks and tags hold no memory of their own,
// so their doors are open unless a prerequisite says otherwise; they are the
// corridors between what you know.

export { DOOR_THRESHOLD };

/** Share of a concept's cards known for it to count as learned, when it is someone's prerequisite. */
export const PREREQ_SHARE = 0.5;

export interface WorldNode {
	id: string;
	facet: Facet;
	/** The card's deck, or the hall's own name. '' for a tag or concept. */
	deck: string;
	/** Plain text. */
	title: string;
	/** Cards linked, for concepts (drives node size). 1 for a card. */
	weight: number;
}

export interface Link {
	to: string;
	kind: string;
	/** The edge runs from this node to `to`. False when it runs back, true for both. */
	out: boolean;
}

export interface World {
	nodes: Map<string, WorldNode>;
	/** Both directions: a passage is walkable either way. Direction is kept on the link. */
	links: Map<string, Link[]>;
	/** For each node, the nodes with a prereq_of edge into it: what it builds on. */
	prereqs: Map<string, string[]>;
	/**
	 * For each concept, every card under it: its own, and those of the narrower
	 * concepts below it (a::b's cards count for a). Drives size and progress.
	 */
	members: Map<string, string[]>;
	/** For each concept, the narrower concepts directly below it. */
	children: Map<string, string[]>;
}

/** What FSRS knows about one card, reduced to what the rules read. */
export interface Memory {
	stability: number;
	/** 0 new, 1 learning, 2 review, 3 relearning. */
	state: number;
	due: Date;
	/** Recall probability now, from the scheduler. Null for a card never reviewed. */
	strength: number | null;
}

export interface Ctx {
	world: World;
	memory: Map<string, Memory>;
	now: Date;
	/** New cards each deck may still introduce today, shared with Cards (select.ts NEW_PER_DAY). */
	newLeft: Map<string, number>;
}

export interface Run {
	current: string;
	visited: Set<string>;
}

// When two nodes are joined by more than one edge, the door takes the most
// telling kind: a prerequisite says more than a shared tag.
const KIND_RANK: Record<string, number> = {
	prereq_of: 0,
	similar_to: 1,
	cites: 2,
	tag: 3,
	deck: 4
};
const rank = (kind: string) => KIND_RANK[kind] ?? 5;

export function buildWorld(
	nodes: WorldNode[],
	edges: { srcId: string; dstId: string; kind: string }[]
): World {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const best = new Map<string, Map<string, Link>>();
	const prereqs = new Map<string, string[]>();
	const put = (a: string, b: string, kind: string, out: boolean) => {
		const m = best.get(a) ?? new Map<string, Link>();
		const had = m.get(b);
		if (!had || rank(kind) < rank(had.kind)) m.set(b, { to: b, kind, out });
		// The same kind both ways (a deck edge and its mirror) is a two-way passage.
		else if (had.kind === kind && had.out !== out) had.out = true;
		best.set(a, m);
	};
	for (const e of edges) {
		// An edge to a node outside this world (deleted, or another tenant's) is not a door.
		if (e.srcId === e.dstId || !byId.has(e.srcId) || !byId.has(e.dstId)) continue;
		put(e.srcId, e.dstId, e.kind, true);
		put(e.dstId, e.srcId, e.kind, false);
		if (e.kind === 'prereq_of') prereqs.set(e.dstId, [...(prereqs.get(e.dstId) ?? []), e.srcId]);
	}
	const links = new Map<string, Link[]>();
	for (const [id, m] of best) links.set(id, [...m.values()]);

	// Hierarchy is an edge from the narrower concept to the broader one, of the
	// facet's own kind (tag → tag, deck → deck). Names are not compared: titles are
	// truncated for display, and a long lineage would stop matching.
	const children = new Map<string, string[]>();
	for (const e of edges) {
		const a = byId.get(e.srcId);
		const b = byId.get(e.dstId);
		if (!a || !b || a.facet === 'card' || a.facet !== b.facet || e.kind !== a.facet) continue;
		children.set(b.id, [...(children.get(b.id) ?? []), a.id]);
	}
	const members = new Map<string, string[]>();
	const collect = (id: string, trail: Set<string>): Set<string> => {
		const out = new Set<string>();
		for (const l of links.get(id) ?? []) if (byId.get(l.to)?.facet === 'card') out.add(l.to);
		for (const c of children.get(id) ?? []) {
			if (trail.has(c)) continue; // a cycle in bad data must not recurse forever
			trail.add(c);
			for (const x of members.get(c) ?? collect(c, trail)) out.add(x);
			trail.delete(c);
		}
		members.set(id, [...out]);
		return out;
	};
	for (const n of nodes) {
		if (n.facet === 'card') continue;
		if (!members.has(n.id)) collect(n.id, new Set([n.id]));
		n.weight = members.get(n.id)!.length;
	}
	return { nodes: byId, links, prereqs, members, children };
}

export function isCard(ctx: Ctx, id: string): boolean {
	return ctx.world.nodes.get(id)?.facet === 'card';
}

/**
 * A card whose stability clears the bar and that is not relearning: the player
 * has shown they can recall it. A lapse (Again on a known card) puts FSRS in
 * relearning; a mature card's stability can stay well above the bar after one,
 * and a recall-gated door should still close until the card is recalled again.
 */
export function knows(m: Memory | undefined): boolean {
	return !!m && m.stability >= DOOR_THRESHOLD && m.state !== 3;
}

export function isKnown(ctx: Ctx, id: string): boolean {
	return isCard(ctx, id) && knows(ctx.memory.get(id));
}

/** How many of a concept's cards, including those under narrower concepts, are known. */
export function progressOf(ctx: Ctx, id: string) {
	const cards = ctx.world.members.get(id) ?? [];
	let known = 0;
	for (const c of cards) if (isKnown(ctx, c)) known++;
	return { known, total: cards.length };
}

/**
 * The concepts a change in one card's memory takes past CLEAR_SHARE known: the
 * moment a deck or tag counts as cleared. `before` and `after` are the card's
 * memory either side of a review.
 */
export function clearedBy(
	ctx: Ctx,
	cardId: string,
	before: Memory | undefined,
	after: Memory,
	share: number
): string[] {
	if (knows(before) || !knows(after)) return [];
	const out: string[] = [];
	for (const [id, cards] of ctx.world.members) {
		if (!cards.includes(cardId)) continue;
		let known = 0;
		for (const c of cards) if (c !== cardId && isKnown(ctx, c)) known++;
		if (known / cards.length < share && (known + 1) / cards.length >= share)
			out.push(ctx.world.nodes.get(id)!.title);
	}
	return out.sort();
}

/**
 * Whether a prerequisite is satisfied: a card you know, or a concept with at
 * least PREREQ_SHARE of its cards known. Reads knowledge only, never gates, so a
 * cycle of prerequisites cannot recurse.
 */
function learned(ctx: Ctx, id: string): boolean {
	if (isCard(ctx, id)) return isKnown(ctx, id);
	const p = progressOf(ctx, id);
	return p.total === 0 || p.known / p.total >= PREREQ_SHARE;
}

function unmetPrereqs(ctx: Ctx, id: string): string[] {
	return (ctx.world.prereqs.get(id) ?? [])
		.filter((p) => !learned(ctx, p))
		.map((p) => ctx.world.nodes.get(p)!.title);
}

/** Whether the door into `id` opens, and if not, whether a recall attempt is on offer. */
export function gate(ctx: Ctx, id: string): Gate {
	const node = ctx.world.nodes.get(id);
	if (!node) return { status: 'open' };
	const m = ctx.memory.get(id);
	const dueNow = !!m && m.state !== 0 && m.due.getTime() <= ctx.now.getTime();
	// A card you know stays open, prerequisites or not: you already know it.
	if (node.facet === 'card' && isKnown(ctx, id))
		return dueNow ? { status: 'open', due: true } : { status: 'open' };
	const needs = unmetPrereqs(ctx, id);
	if (needs.length) return { status: 'sealed', reason: 'prereq', needs };
	if (node.facet !== 'card') return { status: 'open' };
	if (!m || m.state === 0) {
		return (ctx.newLeft.get(node.deck) ?? 0) > 0
			? { status: 'locked' }
			: { status: 'sealed', reason: 'new-cap' };
	}
	// Missed before: FSRS decides when it is worth asking again (retry rule).
	return dueNow
		? { status: 'locked' }
		: { status: 'sealed', reason: 'cooling', retryAt: m.due.toISOString() };
}

/**
 * What the map shows. Fog of war over what you have not learned:
 * - every card you know, and every node you have stood in;
 * - every deck hall, as the entrances;
 * - every concept touching a card you know, and the broader tags above those.
 * Cards you do not know stay hidden unless a door from where you stand leads to
 * them (see buildMap's ghosts).
 */
export function revealed(ctx: Ctx, run: Run): Set<string> {
	const seen = new Set<string>();
	const found: string[] = [];
	const reveal = (id: string) => {
		if (seen.has(id) || !ctx.world.nodes.has(id)) return;
		seen.add(id);
		if (!isCard(ctx, id)) found.push(id);
	};
	reveal(run.current);
	for (const id of run.visited) reveal(id);
	for (const [id, node] of ctx.world.nodes) {
		if (node.facet === 'deck') reveal(id);
		if (!isKnown(ctx, id)) continue;
		reveal(id);
		for (const l of ctx.world.links.get(id) ?? []) if (!isCard(ctx, l.to)) reveal(l.to);
	}
	// Each found concept reveals the broader ones above it (a::b reveals a), not
	// the narrower ones below: a parent tag does not give away its children.
	while (found.length) {
		const from = ctx.world.nodes.get(found.pop()!)!;
		for (const l of ctx.world.links.get(from.id) ?? []) {
			const to = ctx.world.nodes.get(l.to)!;
			if (l.out && to.facet === from.facet && l.kind === from.facet) reveal(to.id);
		}
	}
	return seen;
}

export function isAdjacent(ctx: Ctx, from: string, to: string): boolean {
	return (ctx.world.links.get(from) ?? []).some((l) => l.to === to);
}

export type MoveCheck = 'ok' | 'unknown-node' | 'here' | 'unreachable' | 'locked' | 'sealed';

function reachable(ctx: Ctx, run: Run, to: string, shown?: Set<string>): boolean {
	return isAdjacent(ctx, run.current, to) || (shown ?? revealed(ctx, run)).has(to);
}

/**
 * Whether the player may step from where they stand into `to`. Reachable means a
 * door from this room, or anywhere the map shows (fast travel over known ground).
 * The door must also be open.
 */
export function checkMove(ctx: Ctx, run: Run, to: string): MoveCheck {
	if (!ctx.world.nodes.has(to)) return 'unknown-node';
	if (to === run.current) return 'here';
	if (!reachable(ctx, run, to)) return 'unreachable';
	const g = gate(ctx, to);
	return g.status === 'open' ? 'ok' : g.status;
}

/**
 * Whether the door into `to` offers an encounter: a locked door (a first meeting
 * or a rematch), or an open card FSRS says is due (a review to keep it open).
 * The room you stand in counts: a due card you are standing in can be reviewed.
 */
export function checkEncounter(ctx: Ctx, run: Run, to: string): MoveCheck {
	if (!ctx.world.nodes.has(to)) return 'unknown-node';
	if (!isCard(ctx, to)) return 'unreachable';
	if (to !== run.current && !reachable(ctx, run, to)) return 'unreachable';
	const g = gate(ctx, to);
	if (g.status === 'locked' || g.due) return 'ok';
	return g.status === 'sealed' ? 'sealed' : 'unreachable';
}

const STATUS_ORDER = { open: 0, locked: 1, sealed: 2 } as const;
const FACET_ORDER = { deck: 0, tag: 1, concept: 2, card: 3 } as const;

/**
 * The room the player stands in, without card HTML (repo.ts adds that for the one
 * room on screen). Doors: the deck hall, then tags and concepts, then cards due
 * for review, open cards, encounters on offer (rematches before first meetings),
 * then sealed ones by when they reopen.
 */
export function describeRoom(ctx: Ctx, run: Run): Room {
	const node = ctx.world.nodes.get(run.current);
	if (!node) throw new Error(`no node ${run.current} in this world`);
	const doors: Door[] = (ctx.world.links.get(node.id) ?? []).map((l) => {
		const to = ctx.world.nodes.get(l.to)!;
		const m = ctx.memory.get(l.to);
		return {
			to: l.to,
			facet: to.facet,
			title: to.title,
			via: l.kind,
			out: l.out,
			fresh: to.facet === 'card' && (!m || m.state === 0),
			...gate(ctx, l.to)
		};
	});
	doors.sort(
		(a, b) =>
			FACET_ORDER[a.facet] - FACET_ORDER[b.facet] ||
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
			Number(!!b.due) - Number(!!a.due) ||
			Number(a.fresh) - Number(b.fresh) ||
			(a.retryAt ?? '').localeCompare(b.retryAt ?? '') ||
			a.title.localeCompare(b.title) ||
			a.to.localeCompare(b.to)
	);
	const room: Room = { id: node.id, facet: node.facet, title: node.title, doors };
	if (node.facet === 'card') {
		room.deck = node.deck;
		room.strength = ctx.memory.get(node.id)?.strength ?? null;
	} else {
		room.progress = progressOf(ctx, node.id);
	}
	return room;
}

/**
 * The next encounter worth having, across the whole map, not just this room.
 * The gradient until prereq_of edges exist:
 * 1. reviews: known cards that are due, least retrievable first (about to slip);
 * 2. rematches: missed cards that are due again;
 * 3. first meetings next to what you already know: the fresh card whose concepts
 *    are best known, so a new room is as close to familiar ground as possible.
 * Ties go to the room you stand in, then its doors: walking there is free (the
 * player is taken to it), so it only breaks ties. Candidates are the room's own
 * doors and every card touching a concept on the map.
 */
export function suggest(ctx: Ctx, run: Run): Suggestion | null {
	const shown = revealed(ctx, run);
	const pool = new Set<string>();
	if (isCard(ctx, run.current)) pool.add(run.current);
	for (const l of ctx.world.links.get(run.current) ?? []) if (isCard(ctx, l.to)) pool.add(l.to);
	for (const id of shown) {
		if (isCard(ctx, id)) pool.add(id);
		else for (const l of ctx.world.links.get(id) ?? []) if (isCard(ctx, l.to)) pool.add(l.to);
	}
	type Scored = { id: string; kind: Suggestion['kind']; tier: number; near: number; score: number };
	const scored: Scored[] = [];
	for (const id of pool) {
		const g = gate(ctx, id);
		if (!(g.status === 'locked' || g.due)) continue;
		const m = ctx.memory.get(id);
		const near = id === run.current || isAdjacent(ctx, run.current, id) ? 0 : 1;
		if (g.due) scored.push({ id, kind: 'review', tier: 0, near, score: m?.strength ?? 0 });
		else if (m && m.state !== 0)
			scored.push({ id, kind: 'rematch', tier: 1, near, score: m.strength ?? 0 });
		else {
			// Familiarity: the best-known share among the card's concepts. Higher first.
			let best = 0;
			for (const l of ctx.world.links.get(id) ?? []) {
				if (isCard(ctx, l.to)) continue;
				const p = progressOf(ctx, l.to);
				if (p.total) best = Math.max(best, p.known / p.total);
			}
			scored.push({ id, kind: 'new', tier: 2, near, score: -best });
		}
	}
	if (!scored.length) return null;
	scored.sort(
		(a, b) =>
			a.tier - b.tier ||
			a.score - b.score ||
			a.near - b.near ||
			ctx.world.nodes.get(a.id)!.title.length - ctx.world.nodes.get(b.id)!.title.length ||
			(a.id < b.id ? -1 : 1)
	);
	// Every fresh card whose deck has allowance left is on offer, but only that
	// many can be met today: count what the day can hold, not the whole deck.
	const counts = { review: 0, rematch: 0, new: 0 };
	const freshByDeck = new Map<string, number>();
	for (const s of scored) {
		if (s.kind !== 'new') counts[s.kind]++;
		else {
			const deck = ctx.world.nodes.get(s.id)!.deck;
			freshByDeck.set(deck, (freshByDeck.get(deck) ?? 0) + 1);
		}
	}
	for (const [deck, n] of freshByDeck) counts.new += Math.min(n, ctx.newLeft.get(deck) ?? 0);
	const top = scored[0];
	return {
		to: top.id,
		title: ctx.world.nodes.get(top.id)!.title,
		kind: top.kind,
		waiting: counts.review + counts.rematch + counts.new,
		counts
	};
}

/**
 * How far a card's memory is toward opening its door, 0..1: stability over the
 * bar. 1 only for a card `knows` accepts; a relearning card is one recall short
 * whatever its stability, so it stops just below.
 */
export function holdOf(m: Memory | undefined): number {
	if (!m || m.state === 0) return 0;
	if (knows(m)) return 1;
	return Math.min(m.state === 3 ? 0.9 : 0.99, Math.max(0, m.stability / DOOR_THRESHOLD));
}

/**
 * Where to stand to face `to`: here if it is a door from here (or here), else
 * the best-known open concept next to it that the player can reach. Null if none.
 */
export function approach(ctx: Ctx, run: Run, to: string): string | null {
	if (to === run.current || isAdjacent(ctx, run.current, to)) return run.current;
	const shown = revealed(ctx, run);
	let best: { id: string; share: number } | null = null;
	for (const l of ctx.world.links.get(to) ?? []) {
		if (isCard(ctx, l.to) || !reachable(ctx, run, l.to, shown)) continue;
		if (gate(ctx, l.to).status !== 'open') continue;
		const p = progressOf(ctx, l.to);
		const share = p.total ? p.known / p.total : 0;
		if (!best || share > best.share || (share === best.share && l.to < best.id))
			best = { id: l.to, share };
	}
	return best?.id ?? null;
}

export type Layout = Map<string, { x: number; y: number }>;

/**
 * The map: revealed nodes at their layout positions, the edges among them, and
 * the current room's doors into unknown cards as faint ghosts.
 */
export function buildMap(ctx: Ctx, run: Run, layout: Layout): MapView {
	const shown = revealed(ctx, run);
	const ghosts = new Set<string>();
	for (const l of ctx.world.links.get(run.current) ?? []) {
		if (!shown.has(l.to) && isCard(ctx, l.to)) ghosts.add(l.to);
	}
	const nodes: MapNode[] = [];
	const index = new Map<string, number>();
	let cardsTotal = 0;
	let cardsKnown = 0;
	let conceptsTotal = 0;
	let conceptsFound = 0;
	for (const [id, n] of ctx.world.nodes) {
		const known = isKnown(ctx, id);
		if (n.facet === 'card') {
			cardsTotal++;
			if (known) cardsKnown++;
		} else {
			conceptsTotal++;
			if (shown.has(id)) conceptsFound++;
		}
		const ghost = ghosts.has(id);
		if (!shown.has(id) && !ghost) continue;
		const p = layout.get(id) ?? { x: 0, y: 0 };
		let strength: number | null;
		if (n.facet === 'card') strength = ctx.memory.get(id)?.strength ?? null;
		else {
			const pr = progressOf(ctx, id);
			strength = pr.total ? pr.known / pr.total : null;
		}
		index.set(id, nodes.length);
		nodes.push({
			id,
			facet: n.facet,
			title: n.title,
			x: p.x,
			y: p.y,
			open: gate(ctx, id).status === 'open',
			visited: run.visited.has(id) || id === run.current,
			strength,
			...(n.facet === 'card' ? {} : { weight: n.weight }),
			...(ghost ? { ghost: true } : {})
		});
	}
	const edges: [number, number][] = [];
	for (const [id, links] of ctx.world.links) {
		const a = index.get(id);
		if (a === undefined) continue;
		for (const l of links) {
			const b = index.get(l.to);
			if (b !== undefined && a < b) edges.push([a, b]);
		}
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x);
		maxY = Math.max(maxY, n.y);
	}
	return {
		nodes,
		edges,
		current: run.current,
		bounds: nodes.length ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
		stats: {
			cardsKnown,
			cardsTotal,
			conceptsFound,
			conceptsTotal,
			visited: [...run.visited].filter((id) => ctx.world.nodes.has(id)).length
		}
	};
}

/**
 * Where a player starts: the top-level deck hall they know most cards in, so the
 * map opens on lit ground (Cards comes before Quest, so most arrive with
 * history). Ties, and a player who knows nothing yet, go to the biggest hall,
 * then by name. Null for a world with no decks (nothing imported yet).
 */
export function entrance(ctx: Ctx): string | null {
	const halls = [...ctx.world.nodes.values()].filter((n) => n.facet === 'deck');
	const top = halls.filter((n) => !n.deck.includes('::'));
	const pool = (top.length ? top : halls).map((h) => ({ h, known: progressOf(ctx, h.id).known }));
	pool.sort(
		(a, b) =>
			b.known - a.known ||
			b.h.weight - a.h.weight ||
			a.h.title.localeCompare(b.h.title) ||
			(a.h.id < b.h.id ? -1 : 1)
	);
	return pool[0]?.h.id ?? null;
}
