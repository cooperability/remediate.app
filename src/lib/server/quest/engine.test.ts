import { describe, expect, it } from 'vitest';
import {
	buildMap,
	buildWorld,
	checkEncounter,
	checkMove,
	describeRoom,
	DOOR_THRESHOLD,
	entrance,
	gate,
	revealed,
	type Ctx,
	type Memory,
	type Run,
	type WorldNode
} from './engine';
import { layoutWorld } from './layout';

const now = new Date('2026-09-24T12:00:00Z');
const later = new Date('2026-09-24T12:10:00Z');
const earlier = new Date('2026-09-24T11:50:00Z');

// Deck D (hall h) with tags t (logic) and u (history), and five cards:
//   known   k1 (t)      stability above the bar
//   known   k2 (t, u)
//   fresh   n1 (u)      never reviewed
//   missed  m1 (t)      reviewed, below the bar, due now
//   cooling m2 (t)      reviewed, below the bar, due later
function fixture(over: Partial<Ctx> = {}) {
	const card = (id: string): WorldNode => ({ id, facet: 'card', deck: 'D', title: id, weight: 1 });
	const nodes: WorldNode[] = [
		{ id: 'h', facet: 'deck', deck: 'D', title: 'D', weight: 5 },
		{ id: 't', facet: 'tag', deck: '', title: 'logic', weight: 4 },
		{ id: 'u', facet: 'tag', deck: '', title: 'history', weight: 2 },
		{ id: 'u2', facet: 'tag', deck: '', title: 'history::rome', weight: 0 },
		...['k1', 'k2', 'n1', 'm1', 'm2'].map(card)
	];
	const edges = [
		...['k1', 'k2', 'n1', 'm1', 'm2'].map((c) => ({ srcId: c, dstId: 'h', kind: 'deck' })),
		{ srcId: 'k1', dstId: 't', kind: 'tag' },
		{ srcId: 'k2', dstId: 't', kind: 'tag' },
		{ srcId: 'k2', dstId: 'u', kind: 'tag' },
		{ srcId: 'n1', dstId: 'u', kind: 'tag' },
		{ srcId: 'm1', dstId: 't', kind: 'tag' },
		{ srcId: 'm2', dstId: 't', kind: 'tag' },
		{ srcId: 'u2', dstId: 'u', kind: 'tag' },
		// Dangling: points outside the world.
		{ srcId: 'k1', dstId: 'ghost', kind: 'similar_to' }
	];
	const mem = (stability: number, state: number, due: Date): Memory => ({
		stability,
		state,
		due,
		strength: state ? 0.9 : null
	});
	const ctx: Ctx = {
		world: buildWorld(nodes, edges),
		memory: new Map([
			['k1', mem(DOOR_THRESHOLD + 2, 2, later)],
			['k2', mem(DOOR_THRESHOLD, 2, earlier)],
			['m1', mem(0.2, 1, earlier)],
			['m2', mem(0.3, 3, later)]
		]),
		now,
		newLeft: new Map([['D', 5]]),
		...over
	};
	return ctx;
}
const at = (current: string, visited: string[] = []): Run => ({
	current,
	visited: new Set([current, ...visited])
});

describe('gate: the door rule (PRD QST-2)', () => {
	const ctx = fixture();
	it('opens a card at or above the stability bar, due or not', () => {
		expect(gate(ctx, 'k1')).toEqual({ status: 'open' });
		expect(gate(ctx, 'k2')).toEqual({ status: 'open' });
	});
	it('always opens decks and tags: they hold no memory of their own', () => {
		expect(gate(ctx, 'h').status).toBe('open');
		expect(gate(ctx, 't').status).toBe('open');
	});
	it('offers an encounter for a never-seen card while the deck has new cards left', () => {
		expect(gate(ctx, 'n1')).toEqual({ status: 'locked' });
	});
	it('seals a never-seen card once the shared daily allowance is spent', () => {
		expect(gate(fixture({ newLeft: new Map([['D', 0]]) }), 'n1')).toEqual({
			status: 'sealed',
			reason: 'new-cap'
		});
		expect(gate(fixture({ newLeft: new Map() }), 'n1').status).toBe('sealed');
	});
	it('offers a rematch for a missed card once FSRS says it is due', () => {
		expect(gate(ctx, 'm1')).toEqual({ status: 'locked' });
	});
	it('keeps a missed card sealed until it is due, and says when', () => {
		expect(gate(ctx, 'm2')).toEqual({
			status: 'sealed',
			reason: 'cooling',
			retryAt: later.toISOString()
		});
	});
	it('reads a review_state row still in state 0 as new', () => {
		const c = fixture();
		c.memory.set('n1', { stability: 0, state: 0, due: earlier, strength: null });
		expect(gate(c, 'n1').status).toBe('locked');
	});
});

describe('buildWorld', () => {
	it('walks edges both ways and drops edges to nodes outside the world', () => {
		const ctx = fixture();
		expect(
			ctx.world.links
				.get('t')!
				.map((l) => l.to)
				.sort()
		).toEqual(['k1', 'k2', 'm1', 'm2']);
		expect(ctx.world.links.get('k1')!.some((l) => l.to === 'ghost')).toBe(false);
	});
	it('gives a door the most telling kind when two edges join the same pair', () => {
		const w = buildWorld(
			[
				{ id: 'a', facet: 'card', deck: 'D', title: 'a', weight: 1 },
				{ id: 'b', facet: 'card', deck: 'D', title: 'b', weight: 1 }
			],
			[
				{ srcId: 'a', dstId: 'b', kind: 'similar_to' },
				{ srcId: 'b', dstId: 'a', kind: 'prereq_of' }
			]
		);
		expect(w.links.get('a')).toEqual([{ to: 'b', kind: 'prereq_of' }]);
	});
});

describe('revealed: fog of war', () => {
	const ctx = fixture();
	it('shows halls, known cards, their tags, and where you have been', () => {
		const shown = revealed(ctx, at('h'));
		expect([...shown].sort()).toEqual(['h', 'k1', 'k2', 't', 'u']);
	});
	it('hides cards you do not know until you stand in them', () => {
		const shown = revealed(ctx, at('m1', ['h']));
		expect(shown.has('m1')).toBe(true);
		expect(shown.has('m2')).toBe(false);
		expect(shown.has('n1')).toBe(false);
	});
	it('reveals broader tags above a found one, never narrower ones below', () => {
		expect(revealed(ctx, at('h')).has('u2')).toBe(false);
		const c = fixture();
		c.world.nodes.set('n2', { id: 'n2', facet: 'card', deck: 'D', title: 'n2', weight: 1 });
		c.world.links.set('n2', [{ to: 'u2', kind: 'tag' }]);
		c.world.links.get('u2')!.push({ to: 'n2', kind: 'tag' });
		c.memory.set('n2', { stability: 9, state: 2, due: later, strength: 0.95 });
		const shown = revealed(c, at('h'));
		expect(shown.has('u2')).toBe(true);
		expect(shown.has('u')).toBe(true);
	});
	it('ignores visited ids that are no longer in the world', () => {
		expect(revealed(ctx, at('h', ['deleted'])).has('deleted')).toBe(false);
	});
});

describe('checkMove and checkEncounter', () => {
	const ctx = fixture();
	it('walks through an open door', () => {
		expect(checkMove(ctx, at('t'), 'k1')).toBe('ok');
	});
	it('refuses a locked or sealed door, and says which', () => {
		expect(checkMove(ctx, at('t'), 'm1')).toBe('locked');
		expect(checkMove(ctx, at('t'), 'm2')).toBe('sealed');
	});
	it('fast-travels across the revealed map without a door', () => {
		// u is not adjacent to m1, but it is on the map.
		expect(checkMove(ctx, at('m1', ['h', 't']), 'u')).toBe('ok');
	});
	it('refuses a hidden node with no door to it', () => {
		expect(checkMove(ctx, at('t'), 'n1')).toBe('unreachable');
		expect(checkMove(ctx, at('t'), 'nowhere')).toBe('unknown-node');
		expect(checkMove(ctx, at('t'), 't')).toBe('here');
	});
	it('starts an encounter only at a reachable locked door', () => {
		expect(checkEncounter(ctx, at('t'), 'm1')).toBe('ok');
		expect(checkEncounter(ctx, at('u'), 'n1')).toBe('ok');
		expect(checkEncounter(ctx, at('t'), 'k1')).toBe('unreachable');
		expect(checkEncounter(ctx, at('t'), 'm2')).toBe('sealed');
		expect(checkEncounter(ctx, at('t'), 'n1')).toBe('unreachable');
	});
	it('re-locks a visited card that has lapsed below the bar', () => {
		const c = fixture();
		c.memory.set('k1', { stability: 0.4, state: 3, due: earlier, strength: 0.3 });
		expect(checkMove(c, at('h', ['k1']), 'k1')).toBe('locked');
		expect(checkEncounter(c, at('h', ['k1']), 'k1')).toBe('ok');
	});
});

describe('describeRoom', () => {
	it('lists concepts first, then open cards, reviews before first meetings, then sealed', () => {
		const room = describeRoom(fixture(), at('h'));
		expect(room.doors.map((d) => [d.to, d.status, d.fresh])).toEqual([
			['k1', 'open', false],
			['k2', 'open', false],
			['m1', 'locked', false],
			['n1', 'locked', true],
			['m2', 'sealed', false]
		]);
		expect(room.progress).toEqual({ known: 2, total: 5 });
	});
	it('puts the deck hall first, then tags, then cards', () => {
		const room = describeRoom(fixture(), at('k2'));
		expect(room.doors.map((d) => [d.facet, d.title])).toEqual([
			['deck', 'D'],
			['tag', 'history'],
			['tag', 'logic']
		]);
		expect(room.deck).toBe('D');
		expect(room.strength).toBe(0.9);
	});
	it('throws for a node outside the world', () => {
		expect(() => describeRoom(fixture(), at('nope'))).toThrow();
	});
});

describe('buildMap', () => {
	it('draws revealed nodes with positions, and edges only between them', () => {
		const ctx = fixture();
		const map = buildMap(ctx, at('h'), layoutWorld(ctx.world));
		expect(map.nodes.map((n) => n.id).sort()).toEqual(['h', 'k1', 'k2', 't', 'u']);
		for (const [a, b] of map.edges) {
			expect(ctx.world.links.get(map.nodes[a].id)!.some((l) => l.to === map.nodes[b].id)).toBe(
				true
			);
		}
		// h–k1, h–k2, t–k1, t–k2, u–k2
		expect(map.edges).toHaveLength(5);
		expect(map.stats).toEqual({
			cardsKnown: 2,
			cardsTotal: 5,
			conceptsFound: 3,
			conceptsTotal: 4,
			visited: 1
		});
		const t = map.nodes.find((n) => n.id === 't')!;
		expect(t.strength).toBe(0.5);
		expect(t.weight).toBe(4);
	});
	it('marks a visited card that lapsed as closed', () => {
		const ctx = fixture();
		ctx.memory.set('k1', { stability: 0.4, state: 3, due: earlier, strength: 0.3 });
		const map = buildMap(ctx, at('h', ['k1']), layoutWorld(ctx.world));
		expect(map.nodes.find((n) => n.id === 'k1')).toMatchObject({ open: false, visited: true });
	});
});

describe('entrance', () => {
	it('starts in the biggest top-level hall', () => {
		const w = buildWorld(
			[
				{ id: 'a', facet: 'deck', deck: 'A', title: 'A', weight: 3 },
				{ id: 'b', facet: 'deck', deck: 'B', title: 'B', weight: 9 },
				{ id: 'bb', facet: 'deck', deck: 'B::x', title: 'B::x', weight: 50 }
			],
			[]
		);
		expect(entrance(w)).toBe('b');
	});
	it('has none in an empty world', () => {
		expect(entrance(buildWorld([], []))).toBeNull();
	});
});
