import type { Layout, World, WorldNode } from './engine';

// Where every node sits on the Quest map. Pure and deterministic: the same world
// always gives the same picture, so a node never jumps when fog lifts around it,
// and the layout is laid over the whole world, not just the revealed part.
//
// Shape, from the outside in:
// 1. Deck halls sit on a ring, spaced by how much each region has to hold.
// 2. Each hall's tags spread through its region like sunflower seeds. A tag that
//    other decks share drifts toward them, so bridges sit on the borders.
// 3. Cards cluster around the concepts they link to: a card with one tag rings
//    that tag, a card with two sits between them, an untagged card rings its hall.
// 4. A few rounds of collision relaxation on a spatial grid pull overlaps apart.
//
// Cost is linear in cards per round of relaxation, plus a quadratic spread over
// the concepts only: the real corpus lays out in a few milliseconds, 4,300 nodes
// in well under 100. repo.ts still caches the result per graph fingerprint, so a
// move pays for it only when the graph itself changed.

/** Distance between neighbouring card dots. Everything else scales from it. */
export const CARD_GAP = 14;
const CONCEPT_CLEAR = 26;
const HALL_GAP = 140;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** A stable 0..1 from a string (FNV-1a). Varies patterns without randomness. */
function unit(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 2 ** 32;
}

const byTitle = (a: WorldNode, b: WorldNode) =>
	a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1);

type P = { x: number; y: number };

export function layoutWorld(world: World): Layout {
	const pos = new Map<string, P>();
	const all = [...world.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	const halls = all.filter((n) => n.facet === 'deck').sort(byTitle);
	const tags = all.filter((n) => n.facet === 'tag');
	const cards = all.filter((n) => n.facet === 'card');
	const neighbours = (id: string) =>
		(world.links.get(id) ?? []).map((l) => world.nodes.get(l.to)!).filter(Boolean);

	// 1. Halls on a ring.
	const hallOfDeck = new Map(halls.map((h) => [h.deck, h.id]));
	const cardsIn = new Map<string, number>();
	for (const c of cards) {
		const h = hallOfDeck.get(c.deck);
		if (h) cardsIn.set(h, (cardsIn.get(h) ?? 0) + 1);
	}
	const radius = new Map(
		halls.map((h) => [h.id, CARD_GAP * Math.sqrt((cardsIn.get(h.id) ?? 0) + 4) * 1.7 + 40])
	);
	if (halls.length === 1) pos.set(halls[0].id, { x: 0, y: 0 });
	else if (halls.length > 1) {
		const n = halls.length;
		let ring = 0;
		for (let i = 0; i < n; i++) {
			const a = radius.get(halls[i].id)!;
			const b = radius.get(halls[(i + 1) % n].id)!;
			ring = Math.max(ring, (a + b + HALL_GAP) / (2 * Math.sin(Math.PI / n)));
		}
		halls.forEach((h, i) => {
			const t = -Math.PI / 2 + (2 * Math.PI * i) / n;
			pos.set(h.id, { x: ring * Math.cos(t), y: ring * Math.sin(t) });
		});
	}
	const origin = { x: 0, y: 0 };
	const hallPos = (id: string | undefined) => (id && pos.get(id)) || origin;

	// 2. Tags through their regions.
	const home = new Map<string, { hall: string | undefined; pull: P; share: number }>();
	for (const t of tags) {
		const counts = new Map<string, number>();
		let total = 0;
		for (const n of neighbours(t.id)) {
			if (n.facet !== 'card') continue;
			const h = hallOfDeck.get(n.deck);
			if (!h) continue;
			counts.set(h, (counts.get(h) ?? 0) + 1);
			total++;
		}
		const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
		const hall = ranked[0]?.[0];
		// Where the other decks' share of this tag pulls it.
		let px = 0;
		let py = 0;
		let others = 0;
		for (const [h, c] of ranked.slice(1)) {
			const p = hallPos(h);
			px += p.x * c;
			py += p.y * c;
			others += c;
		}
		home.set(t.id, {
			hall,
			pull: others ? { x: px / others, y: py / others } : hallPos(hall),
			share: total ? others / total : 0
		});
	}
	const tagsByHall = new Map<string, WorldNode[]>();
	for (const t of tags) {
		const key = home.get(t.id)!.hall ?? '';
		tagsByHall.set(key, [...(tagsByHall.get(key) ?? []), t]);
	}
	for (const [hallId, group] of tagsByHall) {
		group.sort((a, b) => b.weight - a.weight || byTitle(a, b));
		const c = hallPos(hallId || undefined);
		const r = hallId ? radius.get(hallId)! : CARD_GAP * Math.sqrt(group.length) * 4;
		const k = group.length;
		const spin = unit(hallId) * 2 * Math.PI;
		group.forEach((t, j) => {
			// Offset the index so no tag lands on the hall itself.
			const rho = r * 0.88 * Math.sqrt((j + 0.5 + k * 0.18) / (k * 1.18));
			const a = spin + j * GOLDEN;
			const h = home.get(t.id)!;
			const drift = Math.min(0.75, h.share * 0.9);
			const base = { x: c.x + rho * Math.cos(a), y: c.y + rho * Math.sin(a) };
			pos.set(t.id, {
				x: base.x + (h.pull.x - base.x) * drift,
				y: base.y + (h.pull.y - base.y) * drift
			});
		});
	}
	// Spread tags that landed on each other; halls stay put.
	const concepts = [...halls, ...tags];
	const cp = concepts.map((n) => pos.get(n.id)!);
	const reach = concepts.map((n) => CARD_GAP * Math.sqrt(n.weight) * 0.55 + CONCEPT_CLEAR);
	const isHall = concepts.map((n) => n.facet === 'deck');
	for (let round = 0; round < 80; round++) {
		let worst = 0;
		for (let i = 0; i < concepts.length; i++) {
			for (let j = i + 1; j < concepts.length; j++) {
				if (isHall[i] && isHall[j]) continue;
				const pa = cp[i];
				const pb = cp[j];
				const min = reach[i] + reach[j];
				let dx = pb.x - pa.x;
				let dy = pb.y - pa.y;
				if (Math.abs(dx) >= min || Math.abs(dy) >= min) continue;
				let d = Math.hypot(dx, dy);
				if (d >= min) continue;
				if (d < 1e-6) {
					const t = unit(concepts[i].id + concepts[j].id) * 2 * Math.PI;
					dx = Math.cos(t);
					dy = Math.sin(t);
					d = 1;
				}
				const push = (min - d) / 2;
				worst = Math.max(worst, push);
				const ux = dx / d;
				const uy = dy / d;
				// A hall is an anchor: the tag takes the whole push.
				const wa = isHall[i] ? 0 : isHall[j] ? 2 : 1;
				const wb = isHall[j] ? 0 : isHall[i] ? 2 : 1;
				pa.x -= ux * push * wa;
				pa.y -= uy * push * wa;
				pb.x += ux * push * wb;
				pb.y += uy * push * wb;
			}
		}
		if (worst < 0.5) break;
	}

	// 3. Cards around their concepts.
	const groups = new Map<string, { anchor: P; clear: number; members: WorldNode[] }>();
	for (const c of cards) {
		const around = neighbours(c.id).filter((n) => n.facet !== 'card');
		const tagged = around.filter((n) => n.facet === 'tag');
		const using = tagged.length ? tagged : around;
		const key = using
			.map((n) => n.id)
			.sort()
			.join('|');
		let g = groups.get(key);
		if (!g) {
			let x = 0;
			let y = 0;
			for (const n of using) {
				const p = pos.get(n.id)!;
				x += p.x;
				y += p.y;
			}
			const anchor = using.length ? { x: x / using.length, y: y / using.length } : origin;
			// Only a cluster sitting on a concept needs to leave room for it.
			g = { anchor, clear: using.length === 1 ? CONCEPT_CLEAR : 6, members: [] };
			groups.set(key, g);
		}
		g.members.push(c);
	}
	const anchorOf = new Map<string, P>();
	for (const [key, g] of groups) {
		const spin = unit(key) * 2 * Math.PI;
		g.members.forEach((c, i) => {
			const r = g.clear + CARD_GAP * 0.95 * Math.sqrt(i + 0.5);
			const a = spin + i * GOLDEN;
			pos.set(c.id, { x: g.anchor.x + r * Math.cos(a), y: g.anchor.y + r * Math.sin(a) });
			anchorOf.set(c.id, g.anchor);
		});
	}

	// 4. Relax card overlaps on a grid. Concepts are fixed obstacles.
	const cell = CONCEPT_CLEAR;
	const cardMin = CARD_GAP * 0.8;
	// Numeric cell keys: a string per lookup dominated the cost at corpus scale.
	const cellKey = (gx: number, gy: number) => (gx + 0x8000) * 0x10000 + (gy + 0x8000);
	const pts = all.map((n) => pos.get(n.id)!);
	const fixed = all.map((n) => n.facet !== 'card');
	const tether = all.map((n) => anchorOf.get(n.id));
	for (let round = 0; round < 16; round++) {
		const grid = new Map<number, number[]>();
		for (let i = 0; i < all.length; i++) {
			const k = cellKey(Math.floor(pts[i].x / cell), Math.floor(pts[i].y / cell));
			const list = grid.get(k);
			if (list) list.push(i);
			else grid.set(k, [i]);
		}
		let worst = 0;
		for (let i = 0; i < all.length; i++) {
			if (fixed[i]) continue;
			const p = pts[i];
			const gx = Math.floor(p.x / cell);
			const gy = Math.floor(p.y / cell);
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					const list = grid.get(cellKey(gx + ox, gy + oy));
					if (!list) continue;
					for (const j of list) {
						if (j === i) continue;
						const q = pts[j];
						const min = fixed[j] ? CONCEPT_CLEAR * 0.85 : cardMin;
						let dx = p.x - q.x;
						let dy = p.y - q.y;
						if (Math.abs(dx) >= min || Math.abs(dy) >= min) continue;
						let d = Math.hypot(dx, dy);
						if (d >= min) continue;
						if (d < 1e-6) {
							const t = unit(all[i].id + all[j].id) * 2 * Math.PI;
							dx = Math.cos(t);
							dy = Math.sin(t);
							d = 1;
						}
						// Card pairs split the push; against a concept the card takes it all.
						const push = (min - d) * (fixed[j] ? 1 : 0.5);
						worst = Math.max(worst, push);
						p.x += (dx / d) * push;
						p.y += (dy / d) * push;
					}
				}
			}
		}
		// Settled: nothing overlaps by more than a hair.
		if (worst < 0.5) break;
		// A light tether keeps clusters from drifting apart as they relax.
		for (let i = 0; i < all.length; i++) {
			const a = tether[i];
			if (!a) continue;
			pts[i].x += (a.x - pts[i].x) * 0.01;
			pts[i].y += (a.y - pts[i].y) * 0.01;
		}
	}

	const out: Layout = new Map();
	for (const [id, p] of pos)
		out.set(id, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
	return out;
}

const cache = new Map<string, { key: string; layout: Layout }>();
const CACHE_USERS = 64;

/**
 * layoutWorld, memoized per user on a fingerprint of the world's nodes and
 * links. A long-lived server instance lays a world out once per change to it,
 * not once per step.
 */
export function cachedLayout(userId: string, world: World): Layout {
	const parts: string[] = [];
	for (const [id, n] of world.nodes)
		parts.push(`${id}:${n.facet}:${n.deck}:${n.weight}:${n.facet === 'card' ? '' : n.title}`);
	for (const [id, links] of world.links) for (const l of links) parts.push(`${id}>${l.to}`);
	const key = parts.sort().join('|');
	const hit = cache.get(userId);
	if (hit?.key === key) return hit.layout;
	const layout = layoutWorld(world);
	cache.delete(userId);
	cache.set(userId, { key, layout });
	// Oldest first: Map keeps insertion order.
	if (cache.size > CACHE_USERS) cache.delete(cache.keys().next().value!);
	return layout;
}
