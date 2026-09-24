import { hasDb } from '../testing/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as table from '../db/schema';
import { DOOR_THRESHOLD } from '$lib/quest/types';

// Loaded only with a database: `$lib/server/db` throws at import without one.
const dbm = hasDb ? await import('../db') : ({} as typeof import('../db'));
const quest = hasDb ? await import('./repo') : ({} as typeof import('./repo'));
const cards = hasDb ? await import('../cards/repo') : ({} as typeof import('../cards/repo'));
const gradeRoute = hasDb ? await import('../../../routes/api/review/grade/+server') : null;
const { NEW_PER_DAY } = await import('../cards/select');
const { conceptId } = await import('../ingest/identity');

const MIN = 60_000;

/** A grade that went through: not refused, not unknown. */
function outcome(g: Awaited<ReturnType<typeof quest.gradeEncounter>>) {
	if (!g || 'refused' in g) throw new Error(`not graded: ${JSON.stringify(g)}`);
	return g;
}
const t0 = new Date('2026-09-01T12:00:00Z');
const at = (m: number) => new Date(t0.getTime() + m * MIN);

describe.skipIf(!hasDb)('Quest against the database', () => {
	const { db, asTenant } = dbm;
	const run = crypto.randomUUID().slice(0, 8);
	const userId = `test-quest-${run}`;
	const other = `test-quest-other-${run}`;
	const deck = `Deck ${run}`;
	const hall = () => conceptId(userId, 'deck', deck);
	const tagId = (t: string) => conceptId(userId, 'tag', t);
	const card = (i: number) => `${run}-c${i}`;

	async function cleanup() {
		const users = [userId, other];
		await db.delete(table.reviewLog).where(inArray(table.reviewLog.userId, users));
		await db.delete(table.reviewState).where(inArray(table.reviewState.userId, users));
		await db.delete(table.questRun).where(inArray(table.questRun.userId, users));
		await db.delete(table.edge).where(inArray(table.edge.userId, users));
		await db.delete(table.assessment).where(inArray(table.assessment.userId, users));
		await db.delete(table.node).where(inArray(table.node.userId, users));
		await db.delete(table.user).where(inArray(table.user.id, users));
	}

	/** Four cards: c0 logic, c1 logic+history, c2 history, c3 untagged. */
	beforeEach(async () => {
		await cleanup();
		await db.insert(table.user).values([
			{ id: userId, email: `${userId}@test.invalid` },
			{ id: other, email: `${other}@test.invalid` }
		]);
		const tags = [['logic'], ['logic', 'history'], ['history'], []];
		await db.insert(table.node).values(
			tags.map((t, i) => ({
				id: card(i),
				userId,
				deck,
				front: `<b>Q${i}</b>`,
				back: `A${i}`,
				tags: t
			}))
		);
		await quest.syncImportGraph(userId);
	});

	afterAll(cleanup);

	const edgesOf = () =>
		db
			.select({ src: table.edge.srcId, dst: table.edge.dstId, kind: table.edge.kind })
			.from(table.edge)
			.where(eq(table.edge.userId, userId));
	const runRow = async () =>
		(await db.select().from(table.questRun).where(eq(table.questRun.userId, userId)))[0];
	const logs = () => db.select().from(table.reviewLog).where(eq(table.reviewLog.userId, userId));

	describe('syncImportGraph', () => {
		it('derives a hall, a concept per tag, and a door from every card to each', async () => {
			const concepts = await db
				.select({ id: table.node.id, notetype: table.node.notetype, front: table.node.front })
				.from(table.node)
				.where(and(eq(table.node.userId, userId), eq(table.node.kind, 'concept')));
			expect(concepts.map((c) => [c.notetype, c.front]).sort()).toEqual([
				['deck', deck],
				['tag', 'history'],
				['tag', 'logic']
			]);
			// 4 card→hall, 4 card→tag, and a passage from each tag to the hall.
			expect(await edgesOf()).toHaveLength(4 + 4 + 2);
		});

		it('is a no-op when nothing changed', async () => {
			expect(await quest.syncImportGraph(userId)).toEqual({
				concepts: 0,
				removed: 0,
				edgesAdded: 0,
				edgesRemoved: 0
			});
		});

		it('follows a retag: stale doors and orphaned concepts go, a run standing there is moved', async () => {
			await quest.questView(userId, at(0));
			// Stand on the history tag, which the retag below orphans.
			await db
				.update(table.questRun)
				.set({ currentNodeId: tagId('history') })
				.where(eq(table.questRun.userId, userId));
			await db
				.update(table.node)
				.set({ tags: [] })
				.where(inArray(table.node.id, [card(1), card(2)]));
			const r = await quest.syncImportGraph(userId);
			// c1→logic, c1→history, c2→history, and history's passage to the hall.
			expect(r).toMatchObject({ removed: 1, edgesRemoved: 4 });
			expect((await edgesOf()).some((e) => e.dst === tagId('history'))).toBe(false);
			expect((await runRow()).currentNodeId).toBeNull();
			const view = (await quest.questView(userId, at(2)))!;
			expect(view.room.id).toBe(hall());
		});

		it('never touches another tenant, or edges enrichment wrote', async () => {
			await db.insert(table.edge).values({
				userId,
				srcId: card(0),
				dstId: card(2),
				kind: 'similar_to',
				provenance: 'ai'
			});
			await quest.syncImportGraph(userId);
			expect((await edgesOf()).filter((e) => e.kind === 'similar_to')).toHaveLength(1);
			await quest.syncImportGraph(other);
			expect(await edgesOf()).toHaveLength(11);
		});
	});

	describe('the run', () => {
		it('starts in the hall, with every card behind a locked door', async () => {
			const view = (await quest.questView(userId, at(0)))!;
			expect(view.room).toMatchObject({
				id: hall(),
				facet: 'deck',
				progress: { known: 0, total: 4 }
			});
			const cardDoors = view.room.doors.filter((d) => d.facet === 'card');
			expect(cardDoors.map((d) => d.status)).toEqual(['locked', 'locked', 'locked', 'locked']);
			// The hall on the map, and its four locked doors as ghosts.
			expect(view.map.nodes.filter((n) => !n.ghost).map((n) => n.id)).toEqual([hall()]);
			expect(view.map.nodes.filter((n) => n.ghost)).toHaveLength(4);
			expect(view.next).toMatchObject({ kind: 'new', waiting: 4 });
			expect(view.encounter).toBeNull();
		});

		it('creates one run however many loads race', async () => {
			await Promise.all(Array.from({ length: 6 }, () => quest.questView(userId, at(0))));
			expect(
				await db.select().from(table.questRun).where(eq(table.questRun.userId, userId))
			).toHaveLength(1);
		});

		it('is null before anything is imported', async () => {
			expect(await quest.questView(other, at(0))).toBeNull();
		});

		it('refuses a locked door and a door that is not here', async () => {
			await quest.questView(userId, at(0));
			expect(await quest.move(userId, card(0), at(1))).toEqual({ ok: false, reason: 'locked' });
			// A hall passage leads to each tag; from logic, the history-only card is out of reach.
			expect((await quest.move(userId, tagId('logic'), at(1))).ok).toBe(true);
			expect(await quest.move(userId, card(2), at(1))).toEqual({
				ok: false,
				reason: 'unreachable'
			});
			expect(await quest.move(userId, 'nowhere', at(1))).toEqual({
				ok: false,
				reason: 'unknown-node'
			});
		});
	});

	describe('encounters', () => {
		// PRD §12 success criterion 6.
		it('opens a locked door because the card was recalled', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(1), at(1));
			if (!e.ok) throw new Error(e.reason);
			expect(e.encounter).toMatchObject({ nodeId: card(1), front: '<b>Q1</b>', fresh: true });

			const g = await quest.gradeEncounter(userId, e.encounter.encounterId, card(1), 3, at(2));
			expect(g).toEqual({ rating: 3, unlocked: true });

			// The same review write path as Cards, tagged with the surface.
			const [log] = await logs();
			expect(log).toMatchObject({
				nodeId: card(1),
				rating: 3,
				surface: 'quest',
				state: 0,
				encounterId: e.encounter.encounterId,
				assessmentId: null
			});
			const [s] = await db
				.select()
				.from(table.reviewState)
				.where(eq(table.reviewState.nodeId, card(1)));
			expect(s.stability).toBeGreaterThanOrEqual(DOOR_THRESHOLD);

			// Stepped through: standing in the card, and its tags are on the map.
			const view = (await quest.questView(userId, at(3)))!;
			expect(view.room).toMatchObject({ id: card(1), facet: 'card', back: 'A1' });
			expect(view.map.nodes.map((n) => n.id).sort()).toEqual(
				[hall(), card(1), tagId('logic'), tagId('history')].sort()
			);
			expect(view.map.stats).toMatchObject({ cardsKnown: 1, cardsTotal: 4, visited: 2 });
			// And from the tag, fast travel back to the hall.
			expect((await quest.move(userId, tagId('logic'), at(4))).ok).toBe(true);
			expect((await quest.move(userId, hall(), at(5))).ok).toBe(true);
		});

		it('keeps a missed door shut until FSRS says it is due, then offers a rematch', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			const g = outcome(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 1, at(2))
			);
			expect(g.unlocked).toBe(false);
			const retry = new Date(g.retryAt!);
			expect(retry.getTime()).toBeGreaterThan(at(2).getTime());
			expect((await runRow()).currentNodeId).toBe(hall());

			const before = new Date(retry.getTime() - 1000);
			expect(await quest.openEncounter(userId, card(0), before)).toEqual({
				ok: false,
				reason: 'sealed'
			});
			const door = (await quest.questView(userId, before))!.room.doors.find(
				(d) => d.to === card(0)
			)!;
			expect(door).toMatchObject({ status: 'sealed', reason: 'cooling', retryAt: g.retryAt });

			const after = new Date(retry.getTime() + 1000);
			expect((await quest.openEncounter(userId, card(0), after)).ok).toBe(true);
		});

		it('shows the lock moving when a rematch is recalled but the door stays shut', async () => {
			await quest.questView(userId, at(0));
			const first = await quest.openEncounter(userId, card(0), at(1));
			if (!first.ok) throw new Error(first.reason);
			const miss = outcome(
				await quest.gradeEncounter(userId, first.encounter.encounterId, card(0), 1, at(2))
			);
			expect(miss.hold!.before).toBe(0);
			expect(miss.hold!.after).toBeGreaterThan(0);

			// FSRS grows same-day stability slowly: a Good minutes after the miss is a
			// recall, and still below the bar. The player sees the lock move.
			const later = new Date(new Date(miss.retryAt!).getTime() + 1000);
			const again = await quest.openEncounter(userId, card(0), later);
			if (!again.ok) throw new Error(again.reason);
			const g = outcome(
				await quest.gradeEncounter(userId, again.encounter.encounterId, card(0), 3, later)
			);
			expect(g.unlocked).toBe(false);
			expect(g.rating).toBe(3);
			expect(g.hold!.before).toBeCloseTo(miss.hold!.after, 5);
			expect(g.hold!.after).toBeGreaterThan(g.hold!.before);
			expect(g.hold!.after).toBeLessThan(1);
		});

		it('reports a retried grade instead of logging it twice', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(2), at(1));
			if (!e.ok) throw new Error(e.reason);
			const id = e.encounter.encounterId;
			const [a, b] = await Promise.all([
				quest.gradeEncounter(userId, id, card(2), 3, at(2)),
				quest.gradeEncounter(userId, id, card(2), 1, at(2))
			]);
			// The same result either way; only the lock's movement is the first grade's alone.
			const same = (g: typeof a) => {
				const { hold, ...rest } = outcome(g);
				return { ...rest, holdAfter: hold?.after };
			};
			expect(same(a)).toEqual(same(b));
			expect(await logs()).toHaveLength(1);
		});

		it('returns the same encounter for a double tap on one door', async () => {
			await quest.questView(userId, at(0));
			const [a, b] = await Promise.all([
				quest.openEncounter(userId, card(0), at(1)),
				quest.openEncounter(userId, card(0), at(1))
			]);
			expect(a.ok && b.ok && a.encounter.encounterId === b.encounter.encounterId).toBe(true);
			// And a reload offers it again rather than losing it.
			const view = (await quest.questView(userId, at(2)))!;
			expect(view.encounter?.nodeId).toBe(card(0));
		});

		it('refuses a grade for an encounter that is not open, or for another card', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			expect(await quest.gradeEncounter(userId, 'made-up', card(0), 3, at(2))).toBeNull();
			expect(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(1), 3, at(2))
			).toBeNull();
			// Walking away abandons it: stand on a tag, then fast-travel back to the hall.
			await db
				.update(table.questRun)
				.set({ currentNodeId: tagId('logic') })
				.where(eq(table.questRun.userId, userId));
			expect((await quest.move(userId, hall(), at(2))).ok).toBe(true);
			expect(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 3, at(3))
			).toBeNull();
			expect(await logs()).toHaveLength(0);
		});

		it('seals new cards once the daily allowance, shared with Cards, is spent', async () => {
			await quest.questView(userId, at(0));
			// Spend the allowance on the deck as Cards would: first reviews today.
			const logRows = Array.from({ length: NEW_PER_DAY }, (_, i) => ({
				userId,
				nodeId: card(i % 4),
				rating: 3,
				state: 0,
				reviewedAt: at(0),
				surface: 'cards'
			}));
			// Distinct cards count, so register each as its own node.
			const extra = Array.from({ length: NEW_PER_DAY }, (_, i) => ({
				id: `${run}-x${i}`,
				userId,
				deck,
				front: `x${i}`
			}));
			await db.insert(table.node).values(extra);
			await db
				.insert(table.reviewLog)
				.values(logRows.map((l, i) => ({ ...l, nodeId: extra[i].id })));
			const view = (await quest.questView(userId, at(1)))!;
			const fresh = view.room.doors.filter((d) => d.facet === 'card' && d.fresh);
			expect(fresh.length).toBeGreaterThan(0);
			expect(fresh.every((d) => d.status === 'sealed' && d.reason === 'new-cap')).toBe(true);
			expect(await quest.openEncounter(userId, card(0), at(1))).toEqual({
				ok: false,
				reason: 'sealed'
			});
		});

		it('works under row-level security, as a signed-in request runs', async () => {
			const g = await asTenant(userId, async () => {
				await quest.syncImportGraph(userId);
				await quest.questView(userId, at(0));
				const e = await quest.openEncounter(userId, card(3), at(1));
				if (!e.ok) throw new Error(e.reason);
				return quest.gradeEncounter(userId, e.encounter.encounterId, card(3), 4, at(2));
			});
			expect(outcome(g).unlocked).toBe(true);
			// The other tenant sees none of it.
			expect(await asTenant(other, () => db.select().from(table.questRun))).toEqual([]);
			expect(await asTenant(other, () => db.select().from(table.edge))).toEqual([]);
		});
	});

	describe('POST /api/review/grade', () => {
		type Handler = (event: unknown) => Promise<Response>;
		const call = (body: unknown) =>
			(gradeRoute!.POST as unknown as Handler)({
				request: new Request('http://localhost/api', {
					method: 'POST',
					body: JSON.stringify(body)
				}),
				locals: { user: { id: userId, email: `${userId}@test.invalid` } },
				cookies: { get: () => undefined }
			});

		it('routes an encounter grade through the quest path', async () => {
			await quest.questView(userId);
			const e = await quest.openEncounter(userId, card(0));
			if (!e.ok) throw new Error(e.reason);
			const res = await call({ encounterId: e.encounter.encounterId, nodeId: card(0), rating: 3 });
			expect(await res.json()).toEqual({ rating: 3, unlocked: true });
		});

		it('refuses a body that mixes a round and an encounter, or has no card', async () => {
			await expect(
				call({ encounterId: 'x', assessmentId: 'y', nodeId: 'n', rating: 3 })
			).rejects.toMatchObject({
				status: 400
			});
			await expect(call({ encounterId: 'x', rating: 3 })).rejects.toMatchObject({ status: 400 });
			await expect(call({ encounterId: 'x', nodeId: 'n', rating: 3 })).rejects.toMatchObject({
				status: 404
			});
		});
	});

	describe('importDeck', () => {
		it('keeps the map in step with an import', async () => {
			const tsv = [
				'#separator:tab',
				'#html:true',
				'#guid column:1',
				'#notetype column:2',
				'#deck column:3',
				'#tags column:6',
				`g1\tBasic\tImported ${run}\tfront\tback\tfresh-tag`
			].join('\n');
			await cards.importDeck(userId, tsv);
			const e = await edgesOf();
			expect(e.some((x) => x.dst === conceptId(userId, 'tag', 'fresh-tag'))).toBe(true);
			expect(e.some((x) => x.dst === conceptId(userId, 'deck', `Imported ${run}`))).toBe(true);
		});
	});
	describe('review findings', () => {
		const known = (id: string, due: Date) =>
			db
				.insert(table.reviewState)
				.values({
					nodeId: id,
					userId,
					stability: 5,
					difficulty: 5,
					due,
					reps: 3,
					state: 2,
					lastReview: at(-60 * 24)
				})
				.onConflictDoUpdate({
					target: table.reviewState.nodeId,
					set: { stability: 5, state: 2, due }
				});

		it('refuses an encounter whose door a Cards review closed in the meantime', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			// Cards grades it Again: learning, below the bar, due in a minute.
			await db.insert(table.reviewState).values({
				nodeId: card(0),
				userId,
				stability: 0.2,
				difficulty: 6,
				due: at(3),
				reps: 1,
				state: 1
			});
			const g = await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 4, at(2));
			expect(g).toEqual({ refused: 'sealed' });
			expect(await logs()).toHaveLength(0);
			expect(((await runRow()).state as { encounter?: unknown }).encounter).toBeUndefined();
		});

		it('refuses a first meeting once the shared allowance ran out after it opened', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			const extra = Array.from({ length: NEW_PER_DAY }, (_, i) => ({
				id: `${run}-y${i}`,
				userId,
				deck,
				front: `y${i}`
			}));
			await db.insert(table.node).values(extra);
			await db.insert(table.reviewLog).values(
				extra.map((x) => ({
					userId,
					nodeId: x.id,
					rating: 3,
					state: 0,
					reviewedAt: at(1),
					surface: 'cards'
				}))
			);
			expect(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 3, at(2))
			).toEqual({ refused: 'sealed' });
		});

		it('expires an encounter opened on another day', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			const tomorrow = new Date(t0.getTime() + 24 * 60 * MIN);
			expect(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 3, tomorrow)
			).toEqual({ refused: 'stale' });
			expect((await quest.questView(userId, tomorrow))!.encounter).toBeNull();
		});

		it('never deadlocks an import against an encounter grade', async () => {
			const tsv = (tag: string) =>
				[
					'#separator:tab',
					'#html:true',
					'#guid column:1',
					'#notetype column:2',
					'#deck column:3',
					'#tags column:6',
					`dl-${run}\tBasic\t${deck}\tfront\tback\t${tag}`
				].join('\n');
			for (let i = 0; i < 4; i++) {
				await cards.importDeck(userId, tsv(`before${i}`));
				const [x] = await db
					.select({ id: table.node.id })
					.from(table.node)
					.where(and(eq(table.node.userId, userId), eq(table.node.front, 'front')));
				await db
					.update(table.questRun)
					.set({ currentNodeId: tagId(`before${i}`), state: {} })
					.where(eq(table.questRun.userId, userId));
				await quest.questView(userId);
				const e = await quest.openEncounter(userId, x.id);
				if (!e.ok) throw new Error(e.reason);
				// The import retags the card (locks it, orphans the tag the player stands
				// on); the grade locks the run and the card. Both must finish.
				const results = await Promise.allSettled([
					cards.importDeck(userId, tsv(`after${i}`)),
					quest.gradeEncounter(userId, e.encounter.encounterId, x.id, 3)
				]);
				expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
				await db.delete(table.reviewLog).where(eq(table.reviewLog.nodeId, x.id));
				await db.delete(table.reviewState).where(eq(table.reviewState.nodeId, x.id));
			}
		});

		it('keeps a concept another writer links to, when no card carries it any more', async () => {
			await db.insert(table.edge).values({
				userId,
				srcId: card(3),
				dstId: tagId('history'),
				kind: 'similar_to',
				provenance: 'ai'
			});
			await db
				.update(table.node)
				.set({ tags: [] })
				.where(inArray(table.node.id, [card(1), card(2)]));
			expect(await quest.syncImportGraph(userId)).toMatchObject({ removed: 0 });
			expect((await edgesOf()).filter((e) => e.kind === 'similar_to')).toHaveLength(1);
		});

		it('never rewrites a card that happens to hold a concept id', async () => {
			const clash = tagId('clash');
			await db
				.insert(table.node)
				.values({ id: clash, userId, deck, front: 'a card', back: 'b', tags: [] });
			await db
				.update(table.node)
				.set({ tags: ['clash'] })
				.where(eq(table.node.id, card(0)));
			await quest.syncImportGraph(userId);
			const [row] = await db.select().from(table.node).where(eq(table.node.id, clash));
			expect(row).toMatchObject({ kind: 'card', front: 'a card', deck });
		});

		it('walks to the best-known concept and opens the next encounter there', async () => {
			// c0 known and standing in it: c1 shares logic (half known), the best start.
			await known(card(0), at(600));
			await db
				.update(table.questRun)
				.set({ currentNodeId: card(0) })
				.where(eq(table.questRun.userId, userId));
			await quest.questView(userId, at(0));
			await db
				.update(table.questRun)
				.set({ currentNodeId: card(0) })
				.where(eq(table.questRun.userId, userId));
			const r = await quest.nextEncounter(userId, at(1));
			if (!r.ok) throw new Error(r.reason);
			expect(r.encounter.nodeId).toBe(card(1));
			expect(r.view!.room.id).toBe(tagId('logic'));
			expect(r.view!.encounter?.encounterId).toBe(r.encounter.encounterId);
		});

		it('offers a due card as a review, and a miss closes its door', async () => {
			await known(card(0), at(-10));
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(0), at(1));
			if (!e.ok) throw new Error(e.reason);
			expect(e.encounter).toMatchObject({ review: true, fresh: false });
			const g = outcome(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 1, at(2))
			);
			expect(g).toMatchObject({ review: true, unlocked: false });
			const door = (await quest.questView(userId, at(3)))!.room.doors.find((d) => d.to === card(0));
			expect(door).toMatchObject({ status: 'sealed', reason: 'cooling' });
		});

		it('names the tags a recall takes to mastery', async () => {
			await known(card(0), at(600));
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(1), at(1));
			if (!e.ok) throw new Error(e.reason);
			const g = outcome(
				await quest.gradeEncounter(userId, e.encounter.encounterId, card(1), 3, at(2))
			);
			// logic: c0 and now c1, 2 of 2. The hall: 2 of 4, not yet.
			expect(g.cleared).toEqual(['logic']);
		});
	});
});
