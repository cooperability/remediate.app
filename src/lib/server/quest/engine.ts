import {
	DOOR_THRESHOLD,
	type Door,
	type Facet,
	type Gate,
	type MapNode,
	type MapView,
	type Room
} from '$lib/quest/types';

// The Quest rules (TDD §9). Pure: the world, the player's memory of it and the
// clock come in; rooms, doors and the map come out. repo.ts does all the I/O,
// so every rule here is a table test.
//
// One rule carries the product: a door into a card is open iff that card's FSRS
// stability is at least DOOR_THRESHOLD (PRD QST-2). The scheduler's memory model
// is the game's progression system. Decks and tags hold no memory of their own,
// so their doors are always open; they are the corridors between what you know.

export { DOOR_THRESHOLD };

export interface WorldNode {
	id: string;
	facet: Facet;
	/** The card's deck, or the hub's own name. '' for a tag. */
	deck: string;
	/** Plain text. */
	title: string;
	/** Cards linked, for concepts (drives node size). 1 for a card. */
	weight: number;
}

export interface Link {
	to: string;
	kind: string;
}

export interface World {
	nodes: Map<string, WorldNode>;
	/** Both directions: a passage is walkable either way. */
	links: Map<string, Link[]>;
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
	const best = new Map<string, Map<string, string>>();
	const put = (a: string, b: string, kind: string) => {
		const m = best.get(a) ?? new Map<string, string>();
		const had = m.get(b);
		if (had === undefined || rank(kind) < rank(had)) m.set(b, kind);
		best.set(a, m);
	};
	for (const e of edges) {
		// An edge to a node outside this world (deleted, or another tenant's) is not a door.
		if (e.srcId === e.dstId || !byId.has(e.srcId) || !byId.has(e.dstId)) continue;
		put(e.srcId, e.dstId, e.kind);
		put(e.dstId, e.srcId, e.kind);
	}
	const links = new Map<string, Link[]>();
	for (const [id, m] of best)
		links.set(
			id,
			[...m].map(([to, kind]) => ({ to, kind }))
		);
	return { nodes: byId, links };
}

export function isCard(ctx: Ctx, id: string): boolean {
	return ctx.world.nodes.get(id)?.facet === 'card';
}

/** Whether the door into `id` opens, and if not, whether a recall attempt is on offer. */
export function gate(ctx: Ctx, id: string): Gate {
	const node = ctx.world.nodes.get(id);
	if (!node || node.facet !== 'card') return { status: 'open' };
	const m = ctx.memory.get(id);
	if (m && m.stability >= DOOR_THRESHOLD) return { status: 'open' };
	if (!m || m.state === 0) {
		return (ctx.newLeft.get(node.deck) ?? 0) > 0
			? { status: 'locked' }
			: { status: 'sealed', reason: 'new-cap' };
	}
	// Missed before: FSRS decides when it is worth asking again (retry rule).
	return m.due.getTime() <= ctx.now.getTime()
		? { status: 'locked' }
		: { status: 'sealed', reason: 'cooling', retryAt: m.due.toISOString() };
}

/** A card whose door is open: the player has shown they can recall it. */
export function isKnown(ctx: Ctx, id: string): boolean {
	return isCard(ctx, id) && gate(ctx, id).status === 'open';
}

/**
 * What the map shows. Fog of war over what you have not learned:
 * - every card you know, and every node you have stood in;
 * - every deck hub, as the entrances;
 * - every tag touching a card you know, and the broader tags above those.
 * Cards you do not know stay hidden until you stand next to them, where they
 * appear as doors in the room panel rather than on the map.
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
			if (to.facet !== 'card' && isBroader(to, from)) reveal(to.id);
		}
	}
	return seen;
}

/** `a` is broader than `a::b`, in the same facet. */
function isBroader(parent: WorldNode, child: WorldNode): boolean {
	return (
		parent.facet === child.facet &&
		child.title.toLowerCase().startsWith(parent.title.toLowerCase() + '::')
	);
}

export function isAdjacent(ctx: Ctx, from: string, to: string): boolean {
	return (ctx.world.links.get(from) ?? []).some((l) => l.to === to);
}

export type MoveCheck = 'ok' | 'unknown-node' | 'here' | 'unreachable' | 'locked' | 'sealed';

/**
 * Whether the player may step from where they stand into `to`. Reachable means a
 * door from this room, or anywhere the map shows (fast travel over known ground).
 * The door must also be open.
 */
export function checkMove(ctx: Ctx, run: Run, to: string): MoveCheck {
	if (!ctx.world.nodes.has(to)) return 'unknown-node';
	if (to === run.current) return 'here';
	if (!isAdjacent(ctx, run.current, to) && !revealed(ctx, run).has(to)) return 'unreachable';
	const g = gate(ctx, to);
	return g.status === 'open' ? 'ok' : g.status;
}

/** Whether trying the door into `to` starts an encounter: reachable, and locked rather than open or sealed. */
export function checkEncounter(ctx: Ctx, run: Run, to: string): MoveCheck {
	const m = checkMove(ctx, run, to);
	if (m === 'locked') return 'ok';
	return m === 'ok' ? 'unreachable' : m;
}

const STATUS_ORDER = { open: 0, locked: 1, sealed: 2 } as const;
const FACET_ORDER = { deck: 0, tag: 1, card: 2 } as const;

function progressOf(ctx: Ctx, id: string) {
	let known = 0;
	let total = 0;
	for (const l of ctx.world.links.get(id) ?? []) {
		if (!isCard(ctx, l.to)) continue;
		total++;
		if (isKnown(ctx, l.to)) known++;
	}
	return { known, total };
}

/**
 * The room the player stands in, without card HTML (repo.ts adds that for the one
 * room on screen). Doors: the deck hall, then tags, then open cards, then encounters on
 * offer (reviews before first meetings), then sealed ones by when they reopen.
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
			fresh: to.facet === 'card' && (!m || m.state === 0),
			...gate(ctx, l.to)
		};
	});
	doors.sort(
		(a, b) =>
			FACET_ORDER[a.facet] - FACET_ORDER[b.facet] ||
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
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

export type Layout = Map<string, { x: number; y: number }>;

/** The map: revealed nodes at their layout positions, and the edges among them. */
export function buildMap(ctx: Ctx, run: Run, layout: Layout): MapView {
	const shown = revealed(ctx, run);
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
		if (!shown.has(id)) continue;
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
			open: n.facet !== 'card' || known,
			visited: run.visited.has(id) || id === run.current,
			strength,
			...(n.facet === 'card' ? {} : { weight: n.weight })
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
 * Where a new player starts: the biggest top-level deck hall, ties by name. Null
 * for a world with no decks (nothing imported yet).
 */
export function entrance(world: World): string | null {
	const halls = [...world.nodes.values()].filter((n) => n.facet === 'deck');
	const top = halls.filter((n) => !n.deck.includes('::'));
	const pool = top.length ? top : halls;
	pool.sort(
		(a, b) => b.weight - a.weight || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1)
	);
	return pool[0]?.id ?? null;
}
