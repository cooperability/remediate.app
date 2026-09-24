import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAnkiExport } from '$lib/server/ingest/anki-tsv';
import { buildWorld, type World, type WorldNode } from './engine';
import { deriveImportGraph } from './graph';
import { CARD_GAP, layoutWorld } from './layout';

/** A world as loadWorld builds it, from cards. */
function worldOf(cards: { id: string; deck: string; tags: string[] }[]): World {
	const g = deriveImportGraph('u', cards);
	const nodes: WorldNode[] = [
		...cards.map((c) => ({
			id: c.id,
			facet: 'card' as const,
			deck: c.deck,
			title: c.id,
			weight: 1
		})),
		...g.concepts.map((c) => ({
			id: c.id,
			facet: c.facet,
			deck: c.deck,
			title: c.name,
			weight: c.cards
		}))
	];
	return buildWorld(nodes, g.edges);
}

function synthetic(n: number, decks: number, tags: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `c${i}`,
		deck: `Deck ${i % decks}`,
		tags: i % 4 === 0 ? [] : [`t${(i * 7) % tags}`, ...(i % 3 === 0 ? [`t${(i * 13) % tags}`] : [])]
	}));
}

const realCards = readdirSync('source_data')
	.filter((f) => f.endsWith('.txt'))
	.flatMap((f) => parseAnkiExport(readFileSync(`source_data/${f}`, 'utf8'), 'u').notes);

function minCardSpacing(world: World, layout: ReturnType<typeof layoutWorld>) {
	const cards = [...world.nodes.values()].filter((n) => n.facet === 'card');
	let min = Infinity;
	for (let i = 0; i < cards.length; i++) {
		const a = layout.get(cards[i].id)!;
		for (let j = i + 1; j < cards.length; j++) {
			const b = layout.get(cards[j].id)!;
			min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
		}
	}
	return min;
}

describe('layoutWorld', () => {
	it('places every node at a finite position', () => {
		const w = worldOf(synthetic(200, 3, 20));
		const layout = layoutWorld(w);
		expect(layout.size).toBe(w.nodes.size);
		for (const p of layout.values()) {
			expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
		}
	});

	it('is deterministic: same world, same picture, whatever the input order', () => {
		const cards = synthetic(300, 2, 25);
		const a = layoutWorld(worldOf(cards));
		const b = layoutWorld(worldOf([...cards].reverse()));
		expect([...b].sort()).toEqual([...a].sort());
	});

	it('keeps cards apart on the real corpus', () => {
		const w = worldOf(realCards);
		expect(minCardSpacing(w, layoutWorld(w))).toBeGreaterThan(CARD_GAP * 0.5);
	});

	it('keeps deck halls apart and puts a shared tag between them', () => {
		const cards = [
			...Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, deck: 'A', tags: ['only-a'] })),
			...Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, deck: 'B', tags: ['only-b'] })),
			...Array.from({ length: 10 }, (_, i) => ({
				id: `s${i}`,
				deck: i % 2 ? 'A' : 'B',
				tags: ['shared']
			}))
		];
		const w = worldOf(cards);
		const layout = layoutWorld(w);
		const idOf = (facet: string, title: string) =>
			[...w.nodes.values()].find((n) => n.facet === facet && n.title === title)!.id;
		const A = layout.get(idOf('deck', 'A'))!;
		const B = layout.get(idOf('deck', 'B'))!;
		const S = layout.get(idOf('tag', 'shared'))!;
		const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
			Math.hypot(p.x - q.x, p.y - q.y);
		expect(dist(A, B)).toBeGreaterThan(200);
		// The bridge sits nearer the midpoint than either hall's own tag does.
		const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
		expect(dist(S, mid)).toBeLessThan(dist(layout.get(idOf('tag', 'only-a'))!, mid));
		expect(dist(S, mid)).toBeLessThan(dist(layout.get(idOf('tag', 'only-b'))!, mid));
	});

	it('handles a world with no decks, and an empty one', () => {
		const w = buildWorld([{ id: 'x', facet: 'card', deck: '', title: 'x', weight: 1 }], []);
		expect(layoutWorld(w).get('x')).toEqual({ x: expect.any(Number), y: expect.any(Number) });
		expect(layoutWorld(buildWorld([], [])).size).toBe(0);
	});

	// PRD §9: room transition < 200 ms p95, and the layout runs on every move.
	it('lays out the planned corpus size (≈4,300 nodes) within budget', () => {
		const w = worldOf(synthetic(4200, 4, 90));
		const t0 = performance.now();
		layoutWorld(w);
		const ms = performance.now() - t0;
		// Generous for slow CI runners; a warm laptop does this in well under 100 ms.
		expect(ms).toBeLessThan(400);
	});

	it('lays out the real corpus fast', () => {
		const w = worldOf(realCards);
		const t0 = performance.now();
		layoutWorld(w);
		expect(performance.now() - t0).toBeLessThan(100);
	});
});
