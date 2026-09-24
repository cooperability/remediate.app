import { describe, expect, it } from 'vitest';
import { conceptId } from '$lib/server/ingest/identity';
import { deriveImportGraph, escapeHtml, lineage } from './graph';

const U = 'u1';
const deck = (name: string) => conceptId(U, 'deck', name);
const tag = (name: string) => conceptId(U, 'tag', name.toLowerCase());

describe('lineage', () => {
	it('splits Anki hierarchy on ::, not /', () => {
		expect(lineage('a::b::c')).toEqual(['a', 'a::b', 'a::b::c']);
		expect(lineage('Anthro (Psych/Soc)')).toEqual(['Anthro (Psych/Soc)']);
	});
	it('drops empty segments', () => {
		expect(lineage('a::::b::')).toEqual(['a', 'a::b']);
		expect(lineage('')).toEqual([]);
	});
});

describe('escapeHtml', () => {
	it('escapes everything that could open markup or an attribute', () => {
		expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe(
			'&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;'
		);
	});
});

describe('deriveImportGraph', () => {
	it('links each card to its deck hall and each tag', () => {
		const g = deriveImportGraph(U, [
			{ id: 'c1', deck: 'D', tags: ['logic', 'history'] },
			{ id: 'c2', deck: 'D', tags: ['logic'] }
		]);
		expect(g.concepts.map((c) => [c.facet, c.name, c.cards]).sort()).toEqual([
			['deck', 'D', 2],
			['tag', 'history', 1],
			['tag', 'logic', 2]
		]);
		expect(g.edges).toHaveLength(5);
		expect(g.edges).toContainEqual({ srcId: 'c1', dstId: deck('D'), kind: 'deck' });
		expect(g.edges).toContainEqual({ srcId: 'c2', dstId: tag('logic'), kind: 'tag' });
	});

	it('shares one tag concept across decks: the bridge between regions', () => {
		const g = deriveImportGraph(U, [
			{ id: 'a', deck: 'A', tags: ['logic'] },
			{ id: 'b', deck: 'B', tags: ['logic'] }
		]);
		const logic = g.concepts.filter((c) => c.facet === 'tag');
		expect(logic).toHaveLength(1);
		expect(logic[0].deck).toBe('');
		expect(g.edges.filter((e) => e.dstId === logic[0].id).map((e) => e.srcId)).toEqual(['a', 'b']);
	});

	it('treats tags case-insensitively and keeps the most used spelling', () => {
		const g = deriveImportGraph(U, [
			{ id: 'a', deck: 'D', tags: ['Example'] },
			{ id: 'b', deck: 'D', tags: ['example'] },
			{ id: 'c', deck: 'D', tags: ['example', 'EXAMPLE'] }
		]);
		const tags = g.concepts.filter((c) => c.facet === 'tag');
		expect(tags.map((t) => [t.name, t.cards])).toEqual([['example', 3]]);
		// A card carrying two spellings of one tag has one door to it, not two.
		expect(g.edges.filter((e) => e.srcId === 'c' && e.kind === 'tag')).toHaveLength(1);
	});

	it('builds tag and deck hierarchies from ::', () => {
		const g = deriveImportGraph(U, [{ id: 'c', deck: 'Lang::French', tags: ['cs::algo::sort'] }]);
		expect(g.edges).toEqual(
			expect.arrayContaining([
				{ srcId: 'c', dstId: deck('Lang::French'), kind: 'deck' },
				{ srcId: deck('Lang::French'), dstId: deck('Lang'), kind: 'deck' },
				{ srcId: 'c', dstId: tag('cs::algo::sort'), kind: 'tag' },
				{ srcId: tag('cs::algo::sort'), dstId: tag('cs::algo'), kind: 'tag' },
				{ srcId: tag('cs::algo'), dstId: tag('cs'), kind: 'tag' }
			])
		);
		// The card links to the leaf only; broader concepts count it through the chain.
		expect(g.edges.filter((e) => e.srcId === 'c')).toHaveLength(2);
		expect(g.concepts.find((c) => c.name === 'cs')?.cards).toBe(1);
	});

	it("ignores Anki's bookkeeping tags", () => {
		const g = deriveImportGraph(U, [{ id: 'c', deck: 'D', tags: ['leech', 'Marked', 'real'] }]);
		expect(g.concepts.filter((c) => c.facet === 'tag').map((c) => c.name)).toEqual(['real']);
	});

	it('scopes concept ids to the owner, like card ids', () => {
		const a = deriveImportGraph('u1', [{ id: 'c', deck: 'D', tags: ['t'] }]);
		const b = deriveImportGraph('u2', [{ id: 'c', deck: 'D', tags: ['t'] }]);
		expect(a.concepts.map((c) => c.id)).not.toEqual(b.concepts.map((c) => c.id));
	});

	it('is independent of card order', () => {
		const cards = [
			{ id: 'a', deck: 'A', tags: ['x', 'Y'] },
			{ id: 'b', deck: 'B', tags: ['y', 'z'] },
			{ id: 'c', deck: 'A::sub', tags: [] }
		];
		expect(deriveImportGraph(U, [...cards].reverse())).toEqual(deriveImportGraph(U, cards));
	});
});
