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
			expect(await edgesOf()).toHaveLength(4 + 4);
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
			expect(r).toMatchObject({ removed: 1, edgesRemoved: 3 });
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
			expect(await edgesOf()).toHaveLength(9);
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
			expect(view.map.nodes.map((n) => n.id)).toEqual([hall()]);
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
			expect(await quest.move(userId, tagId('logic'), at(1))).toEqual({
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
			const g = (await quest.gradeEncounter(userId, e.encounter.encounterId, card(0), 1, at(2)))!;
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

		it('reports a retried grade instead of logging it twice', async () => {
			await quest.questView(userId, at(0));
			const e = await quest.openEncounter(userId, card(2), at(1));
			if (!e.ok) throw new Error(e.reason);
			const id = e.encounter.encounterId;
			const [a, b] = await Promise.all([
				quest.gradeEncounter(userId, id, card(2), 3, at(2)),
				quest.gradeEncounter(userId, id, card(2), 1, at(2))
			]);
			expect(a).toEqual(b);
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
			expect(g?.unlocked).toBe(true);
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
				locals: { user: { id: userId, email: `${userId}@test.invalid` } }
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
});
