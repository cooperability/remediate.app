import { conceptId } from '$lib/server/ingest/identity';

// The import-derived half of the Quest graph (PRD QST-1: the map is the graph).
//
// Until enrichment (Phase 5) writes similar_to and prereq_of edges, the only
// structure a corpus has is what Anki already records: each card's deck and its
// tags. Each deck and each tag becomes a concept node, each card links to them,
// and each tag links to the halls whose cards use it. Tags shared across decks
// become the bridges between the decks' regions.
//
// Edges with provenance 'import' belong to this module: repo.ts syncImportGraph
// rewrites them to match. Other writers (enrichment, BMX) use their own provenance.
//
// Pure: cards in, rows out. repo.ts diffs the rows against the database.

export interface CardFacts {
	id: string;
	deck: string;
	tags: string[];
}

export type ConceptFacet = 'deck' | 'tag';

export interface ConceptRow {
	id: string;
	facet: ConceptFacet;
	/** Display name, raw. The node's `front` column stores it HTML-escaped. */
	name: string;
	/**
	 * The node's `deck` column: the deck's own name for a deck hub, '' for a tag,
	 * which can span decks. The facet itself is stored in `notetype`, the column
	 * that says what type of note a node is within its kind.
	 */
	deck: string;
	/** How many cards link to it, directly or through a narrower concept. */
	cards: number;
}

export type ImportEdgeKind = 'deck' | 'tag';

export interface EdgeRow {
	srcId: string;
	dstId: string;
	kind: ImportEdgeKind;
}

// Anki's own bookkeeping tags. They mark a card's history, not its subject.
const SYSTEM_TAGS = new Set(['leech', 'marked']);

/**
 * Anki's hierarchy separator. `a::b` is a child of `a`, for tags and decks alike
 * (PRD CRD-6: `/` is not a separator).
 */
const SEP = '::';

/** `a::b::c` → [`a`, `a::b`, `a::b::c`]. Empty segments are dropped. */
export function lineage(name: string): string[] {
	const parts = name.split(SEP).filter((p) => p.trim() !== '');
	return parts.map((_, i) => parts.slice(0, i + 1).join(SEP));
}

/** Escape text for the `front` column, which every surface treats as sanitized HTML. */
export function escapeHtml(s: string): string {
	return s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/**
 * Anki compares tags case-insensitively, so `Example` and `example` are one tag.
 * The concept takes the spelling most cards use; ties go to the first in code
 * point order, so the result does not depend on import order.
 */
function canonicalSpellings(cards: CardFacts[]): Map<string, string> {
	const counts = new Map<string, Map<string, number>>();
	for (const c of cards) {
		for (const tag of new Set(c.tags)) {
			for (const name of lineage(tag)) {
				const key = name.toLowerCase();
				if (SYSTEM_TAGS.has(key)) continue;
				const m = counts.get(key) ?? new Map<string, number>();
				m.set(name, (m.get(name) ?? 0) + 1);
				counts.set(key, m);
			}
		}
	}
	const out = new Map<string, string>();
	for (const [key, spellings] of counts) {
		const [best] = [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
		out.set(key, best[0]);
	}
	return out;
}

/**
 * Every concept and import edge implied by `cards`. Deterministic: the same
 * cards in any order give the same rows in the same order.
 */
export function deriveImportGraph(
	userId: string,
	cards: CardFacts[]
): { concepts: ConceptRow[]; edges: EdgeRow[] } {
	const spelling = canonicalSpellings(cards);
	const concepts = new Map<string, ConceptRow>();
	const members = new Map<string, Set<string>>();
	const edges = new Map<string, EdgeRow>();

	const concept = (facet: ConceptFacet, name: string) => {
		const id = conceptId(userId, facet, facet === 'tag' ? name.toLowerCase() : name);
		if (!concepts.has(id))
			concepts.set(id, { id, facet, name, deck: facet === 'deck' ? name : '', cards: 0 });
		return id;
	};
	const link = (srcId: string, dstId: string, kind: ImportEdgeKind) => {
		if (srcId !== dstId) edges.set(`${srcId}\u0000${dstId}\u0000${kind}`, { srcId, dstId, kind });
	};
	const count = (conceptIdValue: string, cardId: string) => {
		const s = members.get(conceptIdValue) ?? new Set<string>();
		s.add(cardId);
		members.set(conceptIdValue, s);
	};

	/** Link the card to the leaf and each narrower concept to its parent. */
	const attach = (cardId: string, facet: ConceptFacet, names: string[], kind: ImportEdgeKind) => {
		const ids = names.map((n) => concept(facet, n));
		for (const id of ids) count(id, cardId);
		link(cardId, ids[ids.length - 1], kind);
		for (let i = ids.length - 1; i > 0; i--) link(ids[i], ids[i - 1], kind);
	};

	for (const c of cards) {
		const deckNames = lineage(c.deck);
		const hall = deckNames.length ? concept('deck', deckNames[deckNames.length - 1]) : null;
		if (deckNames.length) attach(c.id, 'deck', deckNames, 'deck');
		const seen = new Set<string>();
		for (const tag of c.tags) {
			const names = lineage(tag)
				.filter((n) => !SYSTEM_TAGS.has(n.toLowerCase()))
				.map((n) => spelling.get(n.toLowerCase())!);
			const leaf = names.at(-1);
			if (!leaf || seen.has(leaf.toLowerCase())) continue;
			seen.add(leaf.toLowerCase());
			attach(c.id, 'tag', names, 'tag');
			// A passage from the hall to each tag its cards use, so a deck's halls
			// have corridors from day one and a shared tag joins two halls.
			if (hall) link(concept('tag', leaf), hall, 'deck');
		}
	}

	for (const [id, s] of members) concepts.get(id)!.cards = s.size;
	const byKey =
		<T>(key: (t: T) => string) =>
		(a: T, b: T) =>
			key(a) < key(b) ? -1 : 1;
	return {
		concepts: [...concepts.values()].sort(byKey((c) => c.id)),
		edges: [...edges.values()].sort(byKey((e) => `${e.srcId}\u0000${e.dstId}\u0000${e.kind}`))
	};
}
