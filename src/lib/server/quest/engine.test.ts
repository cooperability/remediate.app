import { describe, expect, it } from 'vitest';
import {
	approach,
	buildMap,
	buildWorld,
	checkEncounter,
	checkMove,
	clearedBy,
	describeRoom,
	DOOR_THRESHOLD,
	entrance,
	gate,
	holdOf,
	isKnown,
	progressOf,
	revealed,
	suggest,
	type Ctx,
	type Memory,
	type Run,
	type WorldNode
} from './engine';
import { layoutWorld } from './layout';

const now = new Date('2026-09-24T12:00:00Z');
const later = new Date('2026-09-24T12:10:00Z');
const earlier = new Date('2026-09-24T11:50:00Z');

const card = (id: string, deck = 'D'): WorldNode => ({
	id,
	facet: 'card',
	deck,
	title: id,
	weight: 1
});
const mem = (stability: number, state: number, due: Date, strength = 0.9): Memory => ({
	stability,
	state,
	due,
	strength: state ? strength : null
});

// Deck D (hall h) with tags t (logic) and u (history), u2 (history::rome) under u,
// and five cards:
//   known   k1 (t)      stability above the bar, not due
//   known   k2 (t, u)   at the bar, due: a review is on offer
//   fresh   n1 (u)      never reviewed
//   missed  m1 (t)      reviewed, below the bar, due now
//   cooling m2 (t)      reviewed, below the bar, due later
function fixture(
	over: Partial<Ctx> = {},
	extraEdges: { srcId: string; dstId: string; kind: string }[] = []
) {
	const nodes: WorldNode[] = [
		{ id: 'h', facet: 'deck', deck: 'D', title: 'D', weight: 0 },
		{ id: 't', facet: 'tag', deck: '', title: 'logic', weight: 0 },
		{ id: 'u', facet: 'tag', deck: '', title: 'history', weight: 0 },
		{ id: 'u2', facet: 'tag', deck: '', title: 'history::rome', weight: 0 },
		...['k1', 'k2', 'n1', 'm1', 'm2'].map((id) => card(id))
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
		// Hall passages, as graph.ts derives them.
		{ srcId: 't', dstId: 'h', kind: 'deck' },
		{ srcId: 'u', dstId: 'h', kind: 'deck' },
		// Dangling: points outside the world.
		{ srcId: 'k1', dstId: 'ghost', kind: 'similar_to' },
		...extraEdges
	];
	const ctx: Ctx = {
		world: buildWorld(nodes, edges),
		memory: new Map([
			['k1', mem(DOOR_THRESHOLD + 2, 2, later)],
			['k2', mem(DOOR_THRESHOLD, 2, earlier, 0.7)],
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
	it('opens a card at or above the stability bar', () => {
		expect(gate(ctx, 'k1')).toEqual({ status: 'open' });
	});
	it('marks an open card that FSRS says is due, so it can be reviewed', () => {
		expect(gate(ctx, 'k2')).toEqual({ status: 'open', due: true });
	});
	it('always opens decks and tags without prerequisites', () => {
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
		c.memory.set('n1', mem(0, 0, earlier));
		expect(gate(c, 'n1').status).toBe('locked');
	});
	it('closes a lapsed card even when its stability stays above the bar', () => {
		// A mature card graded Again: FSRS keeps S ≈ 4.7 but puts it in relearning.
		const c = fixture();
		c.memory.set('k1', mem(4.7, 3, later));
		expect(isKnown(c, 'k1')).toBe(false);
		expect(gate(c, 'k1')).toMatchObject({ status: 'sealed', reason: 'cooling' });
		c.memory.set('k1', mem(4.7, 3, earlier));
		expect(gate(c, 'k1').status).toBe('locked');
	});
});

describe('prerequisites (prereq_of, AI-5)', () => {
	it('seals a card whose prerequisite card is not known, and says what to learn', () => {
		const ctx = fixture({}, [{ srcId: 'm1', dstId: 'n1', kind: 'prereq_of' }]);
		expect(gate(ctx, 'n1')).toEqual({ status: 'sealed', reason: 'prereq', needs: ['m1'] });
	});
	it('opens the gate once the prerequisite is known', () => {
		const ctx = fixture({}, [{ srcId: 'k1', dstId: 'n1', kind: 'prereq_of' }]);
		expect(gate(ctx, 'n1').status).toBe('locked');
	});
	it('gates a concept on a concept: half its cards known opens it', () => {
		// t (logic) has k1, k2 known of four: 50% → open. u needs t.
		const open = fixture({}, [{ srcId: 't', dstId: 'u', kind: 'prereq_of' }]);
		expect(gate(open, 'u').status).toBe('open');
		const shut = fixture({}, [{ srcId: 't', dstId: 'u', kind: 'prereq_of' }]);
		shut.memory.delete('k2');
		expect(gate(shut, 'u')).toMatchObject({
			status: 'sealed',
			reason: 'prereq',
			needs: ['logic']
		});
	});
	it('never seals a card you already know', () => {
		const ctx = fixture({}, [{ srcId: 'n1', dstId: 'k1', kind: 'prereq_of' }]);
		expect(gate(ctx, 'k1').status).toBe('open');
	});
	it('survives a prerequisite cycle', () => {
		const ctx = fixture({}, [
			{ srcId: 'n1', dstId: 'm1', kind: 'prereq_of' },
			{ srcId: 'm1', dstId: 'n1', kind: 'prereq_of' }
		]);
		expect(gate(ctx, 'n1').status).toBe('sealed');
		expect(gate(ctx, 'm1').status).toBe('sealed');
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
		).toEqual(['h', 'k1', 'k2', 'm1', 'm2']);
		expect(ctx.world.links.get('k1')!.some((l) => l.to === 'ghost')).toBe(false);
	});
	it('keeps direction: a prerequisite leads out one way and builds on the other', () => {
		const w = buildWorld([card('a'), card('b')], [{ srcId: 'a', dstId: 'b', kind: 'prereq_of' }]);
		expect(w.links.get('a')).toEqual([{ to: 'b', kind: 'prereq_of', out: true }]);
		expect(w.links.get('b')).toEqual([{ to: 'a', kind: 'prereq_of', out: false }]);
		expect(w.prereqs.get('b')).toEqual(['a']);
	});
	it('gives a door the most telling kind when two edges join the same pair', () => {
		const w = buildWorld(
			[card('a'), card('b')],
			[
				{ srcId: 'a', dstId: 'b', kind: 'similar_to' },
				{ srcId: 'b', dstId: 'a', kind: 'prereq_of' }
			]
		);
		expect(w.links.get('a')).toEqual([{ to: 'b', kind: 'prereq_of', out: false }]);
	});
	it('counts a broader concept by every card under it (:: roll-up)', () => {
		const ctx = fixture();
		expect(ctx.world.members.get('u')!.sort()).toEqual(['k2', 'n1']);
		expect(ctx.world.nodes.get('u2')!.weight).toBe(0);
		const w = buildWorld(
			[
				{ id: 'med', facet: 'deck', deck: 'Med', title: 'Med', weight: 0 },
				{ id: 'ana', facet: 'deck', deck: 'Med::Anatomy', title: 'Med::Anatomy', weight: 0 },
				card('x', 'Med::Anatomy'),
				card('y', 'Med::Anatomy')
			],
			[
				{ srcId: 'x', dstId: 'ana', kind: 'deck' },
				{ srcId: 'y', dstId: 'ana', kind: 'deck' },
				{ srcId: 'ana', dstId: 'med', kind: 'deck' }
			]
		);
		expect(w.nodes.get('med')!.weight).toBe(2);
		expect(w.nodes.get('ana')!.weight).toBe(2);
	});
});

describe('revealed: fog of war', () => {
	const ctx = fixture();
	it('shows halls, known cards, their tags, and where you have been', () => {
		expect([...revealed(ctx, at('h'))].sort()).toEqual(['h', 'k1', 'k2', 't', 'u']);
	});
	it('hides cards you do not know until you stand in them', () => {
		const shown = revealed(ctx, at('m1', ['h']));
		expect(shown.has('m1')).toBe(true);
		expect(shown.has('m2')).toBe(false);
		expect(shown.has('n1')).toBe(false);
	});
	it('reveals broader tags above a found one by edge, whatever the names', () => {
		expect(revealed(ctx, at('h')).has('u2')).toBe(false);
		// A parent whose title (truncated to 90 characters) no longer prefixes the child's.
		const long = 'x'.repeat(89) + '…';
		const w = buildWorld(
			[
				{ id: 'p', facet: 'tag', deck: '', title: long, weight: 0 },
				{ id: 'c', facet: 'tag', deck: '', title: long, weight: 0 },
				card('k')
			],
			[
				{ srcId: 'k', dstId: 'c', kind: 'tag' },
				{ srcId: 'c', dstId: 'p', kind: 'tag' }
			]
		);
		const c = { ...fixture(), world: w, memory: new Map([['k', mem(5, 2, later)]]) };
		expect([...revealed(c, at('k'))].sort()).toEqual(['c', 'k', 'p']);
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
	it('walks a hall passage into a tag not yet on the map', () => {
		const c = fixture();
		c.memory.clear();
		expect(revealed(c, at('h')).has('t')).toBe(false);
		expect(checkMove(c, at('h'), 't')).toBe('ok');
	});
	it('fast-travels across the revealed map without a door', () => {
		expect(checkMove(ctx, at('m1', ['h', 't']), 'u')).toBe('ok');
	});
	it('refuses a hidden node with no door to it', () => {
		expect(checkMove(ctx, at('t'), 'n1')).toBe('unreachable');
		expect(checkMove(ctx, at('t'), 'nowhere')).toBe('unknown-node');
		expect(checkMove(ctx, at('t'), 't')).toBe('here');
	});
	it('offers an encounter at a locked door, or a review at a due one', () => {
		expect(checkEncounter(ctx, at('t'), 'm1')).toBe('ok');
		expect(checkEncounter(ctx, at('u'), 'n1')).toBe('ok');
		expect(checkEncounter(ctx, at('t'), 'k2')).toBe('ok');
		// The room you stand in counts: review the card you are in.
		expect(checkEncounter(ctx, at('k2'), 'k2')).toBe('ok');
	});
	it('offers nothing at an open door that is not due, a sealed one, or a concept', () => {
		expect(checkEncounter(ctx, at('t'), 'k1')).toBe('unreachable');
		expect(checkEncounter(ctx, at('t'), 'm2')).toBe('sealed');
		expect(checkEncounter(ctx, at('t'), 'n1')).toBe('unreachable');
		expect(checkEncounter(ctx, at('k1'), 't')).toBe('unreachable');
	});
});

describe('describeRoom', () => {
	it('orders passages, then due, open, rematches, first meetings, sealed', () => {
		const room = describeRoom(fixture(), at('h'));
		expect(room.doors.map((d) => [d.to, d.status, !!d.due, d.fresh])).toEqual([
			['u', 'open', false, false],
			['t', 'open', false, false],
			['k2', 'open', true, false],
			['k1', 'open', false, false],
			['m1', 'locked', false, false],
			['n1', 'locked', false, true],
			['m2', 'sealed', false, false]
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
		expect(room.strength).toBe(0.7);
	});
	it('says which way a door runs', () => {
		const ctx = fixture({}, [{ srcId: 'k1', dstId: 'k2', kind: 'prereq_of' }]);
		const from1 = describeRoom(ctx, at('k1')).doors.find((d) => d.to === 'k2')!;
		const from2 = describeRoom(ctx, at('k2')).doors.find((d) => d.to === 'k1')!;
		expect([from1.via, from1.out, from2.out]).toEqual(['prereq_of', true, false]);
	});
	it('throws for a node outside the world', () => {
		expect(() => describeRoom(fixture(), at('nope'))).toThrow();
	});
});

describe('suggest: the next encounter', () => {
	it('puts a due review first, then rematches, then first meetings', () => {
		const ctx = fixture();
		expect(suggest(ctx, at('h'))).toEqual({
			to: 'k2',
			title: 'k2',
			kind: 'review',
			waiting: 3,
			counts: { review: 1, rematch: 1, new: 1 }
		});
		ctx.memory.set('k2', mem(DOOR_THRESHOLD, 2, later));
		expect(suggest(ctx, at('h'))).toMatchObject({ to: 'm1', kind: 'rematch' });
		ctx.memory.set('m1', mem(5, 2, later));
		expect(suggest(ctx, at('h'))).toMatchObject({ to: 'n1', kind: 'new', waiting: 1 });
	});
	it('picks the first meeting next to the best-known concept', () => {
		// x (tag t, where k1 is known) and y (tag u2, where nothing is): x first.
		const nodes: WorldNode[] = [
			{ id: 'h', facet: 'deck', deck: 'D', title: 'D', weight: 0 },
			{ id: 't', facet: 'tag', deck: '', title: 'logic', weight: 0 },
			{ id: 'u2', facet: 'tag', deck: '', title: 'rome', weight: 0 },
			card('k1'),
			card('x'),
			card('y')
		];
		const world = buildWorld(nodes, [
			{ srcId: 'k1', dstId: 't', kind: 'tag' },
			{ srcId: 'x', dstId: 't', kind: 'tag' },
			{ srcId: 'y', dstId: 'u2', kind: 'tag' },
			{ srcId: 't', dstId: 'h', kind: 'deck' },
			{ srcId: 'u2', dstId: 'h', kind: 'deck' }
		]);
		const c: Ctx = { ...fixture(), world, memory: new Map([['k1', mem(5, 2, later)]]) };
		expect(suggest(c, at('u2', ['t']))).toMatchObject({ to: 'x', kind: 'new' });
	});
	it('prefers the room you stand in, then its doors, within a tier', () => {
		const ctx = fixture();
		ctx.memory.set('k2', mem(DOOR_THRESHOLD, 2, later));
		// Two rematches, equally faded: the one you stand in wins the tie.
		ctx.memory.set('m2', mem(0.3, 1, earlier));
		expect(suggest(ctx, at('m1', ['h']))!.to).toBe('m1');
		expect(suggest(ctx, at('m2', ['h']))!.to).toBe('m2');
	});
	it('counts only the new cards today can still introduce', () => {
		const nodes: WorldNode[] = [
			{ id: 'h', facet: 'deck', deck: 'D', title: 'D', weight: 0 },
			...['a', 'b', 'c', 'd'].map((id) => card(id))
		];
		const world = buildWorld(
			nodes,
			['a', 'b', 'c', 'd'].map((c) => ({ srcId: c, dstId: 'h', kind: 'deck' }))
		);
		const c: Ctx = { world, memory: new Map(), now, newLeft: new Map([['D', 2]]) };
		expect(suggest(c, at('h'))).toMatchObject({
			kind: 'new',
			waiting: 2,
			counts: { review: 0, rematch: 0, new: 2 }
		});
	});
	it('is null when nothing is on offer', () => {
		const ctx = fixture({ newLeft: new Map([['D', 0]]) });
		ctx.memory.set('k2', mem(5, 2, later));
		ctx.memory.set('m1', mem(5, 2, later));
		expect(suggest(ctx, at('h'))).toBeNull();
	});
});

describe('holdOf: how close a door is to opening', () => {
	it('is 0 for a card never met and 1 for a known one', () => {
		expect(holdOf(undefined)).toBe(0);
		expect(holdOf(mem(0, 0, now))).toBe(0);
		expect(holdOf(mem(DOOR_THRESHOLD, 2, later))).toBe(1);
	});
	it('is stability over the bar below it, never full while the door is shut', () => {
		expect(holdOf(mem(DOOR_THRESHOLD / 4, 1, later))).toBeCloseTo(0.25);
		// Relearning is one recall short, whatever the stability.
		expect(holdOf(mem(DOOR_THRESHOLD * 3, 3, later))).toBeLessThan(1);
	});
});

describe('approach', () => {
	it('stays put for a door from here, else picks a reachable open concept next to it', () => {
		const ctx = fixture();
		expect(approach(ctx, at('h'), 'm1')).toBe('h');
		expect(approach(ctx, at('k1'), 'n1')).toBe('u');
	});
});

describe('clearedBy: region mastery', () => {
	it('names the concepts one recall takes past the share', () => {
		const ctx = fixture();
		// logic: k1, k2 known of four. Learning m1 makes 3/4 = 75%; the hall 3/5.
		const before = ctx.memory.get('m1');
		const after = mem(3, 2, later);
		expect(clearedBy(ctx, 'm1', before, after, 0.75)).toEqual(['logic']);
		expect(clearedBy(ctx, 'm1', before, after, 0.8)).toEqual([]);
	});
	it('names nothing when the card was already known, or still is not', () => {
		const ctx = fixture();
		expect(clearedBy(ctx, 'k1', ctx.memory.get('k1'), mem(9, 2, later), 0.5)).toEqual([]);
		expect(clearedBy(ctx, 'm1', ctx.memory.get('m1'), mem(0.5, 1, later), 0.5)).toEqual([]);
	});
});

describe('buildMap', () => {
	it('draws revealed nodes with positions, and edges only between them', () => {
		const ctx = fixture();
		const map = buildMap(ctx, at('h'), layoutWorld(ctx.world));
		const real = map.nodes.filter((n) => !n.ghost);
		expect(real.map((n) => n.id).sort()).toEqual(['h', 'k1', 'k2', 't', 'u']);
		for (const [a, b] of map.edges) {
			expect(ctx.world.links.get(map.nodes[a].id)!.some((l) => l.to === map.nodes[b].id)).toBe(
				true
			);
		}
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
	it("shows the current room's doors into unknown cards as ghosts", () => {
		const ctx = fixture();
		const map = buildMap(ctx, at('t'), layoutWorld(ctx.world));
		expect(
			map.nodes
				.filter((n) => n.ghost)
				.map((n) => n.id)
				.sort()
		).toEqual(['m1', 'm2']);
	});
	it('marks a visited card that lapsed as closed', () => {
		const ctx = fixture();
		ctx.memory.set('k1', mem(0.4, 3, earlier, 0.3));
		const map = buildMap(ctx, at('h', ['k1']), layoutWorld(ctx.world));
		expect(map.nodes.find((n) => n.id === 'k1')).toMatchObject({ open: false, visited: true });
	});
});

describe('entrance', () => {
	const halls = (known: string[]): Ctx => {
		const w = buildWorld(
			[
				{ id: 'a', facet: 'deck', deck: 'A', title: 'A', weight: 0 },
				{ id: 'b', facet: 'deck', deck: 'B', title: 'B', weight: 0 },
				{ id: 'bb', facet: 'deck', deck: 'B::x', title: 'B::x', weight: 0 },
				card('a1', 'A'),
				card('b1', 'B::x'),
				card('b2', 'B::x'),
				card('b3', 'B::x')
			],
			[
				{ srcId: 'a1', dstId: 'a', kind: 'deck' },
				...['b1', 'b2', 'b3'].map((c) => ({ srcId: c, dstId: 'bb', kind: 'deck' })),
				{ srcId: 'bb', dstId: 'b', kind: 'deck' }
			]
		);
		return { ...fixture(), world: w, memory: new Map(known.map((k) => [k, mem(5, 2, later)])) };
	};
	it('starts a new player in the biggest top-level hall, counting nested decks', () => {
		expect(entrance(halls([]))).toBe('b');
	});
	it('starts a returning player where they know the most', () => {
		expect(entrance(halls(['a1']))).toBe('a');
		expect(progressOf(halls(['b1']), 'b')).toEqual({ known: 1, total: 3 });
	});
	it('has none in an empty world', () => {
		expect(entrance({ ...fixture(), world: buildWorld([], []) })).toBeNull();
	});
});
