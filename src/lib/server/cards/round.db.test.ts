import { hasDb } from '../testing/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as table from '../db/schema';

// Loaded only with a database: `$lib/server/db` throws at import without one.
const { db } = hasDb ? await import('../db') : ({} as typeof import('../db'));
const repo = hasDb ? await import('./repo') : ({} as typeof import('./repo'));

const HOUR = 3_600_000;
const CARDS = 5;
const t0 = new Date('2026-09-01T12:00:00Z');
const at = (h: number) => new Date(t0.getTime() + h * HOUR);

describe.skipIf(!hasDb)('study rounds against the database', () => {
	const run = crypto.randomUUID().slice(0, 8);
	const userId = `test-user-${run}`;
	const deck = `test-deck-${run}`;

	async function cleanup() {
		await db.delete(table.reviewLog).where(eq(table.reviewLog.userId, userId));
		await db.delete(table.reviewState).where(eq(table.reviewState.userId, userId));
		await db.delete(table.assessment).where(eq(table.assessment.userId, userId));
		await db.delete(table.node).where(eq(table.node.userId, userId));
		await db.delete(table.user).where(eq(table.user.id, userId));
	}

	beforeEach(async () => {
		await cleanup();
		await db.insert(table.user).values({ id: userId, email: `${userId}@test.invalid` });
		await db.insert(table.node).values(
			Array.from({ length: CARDS }, (_, i) => ({
				id: `${run}-n${i}`,
				userId,
				deck,
				front: `f${i}`,
				back: `b${i}`,
				tags: [i % 2 ? 'odd' : 'even']
			}))
		);
	});

	afterAll(cleanup);

	const openRounds = () =>
		db.select().from(table.assessment).where(eq(table.assessment.userId, userId));

	it('resumes the open round on a second load instead of opening another', async () => {
		const first = (await repo.startRound(userId, deck, at(0)))!;
		const again = (await repo.startRound(userId, deck, at(1)))!;
		expect(again.assessmentId).toBe(first.assessmentId);
		expect(again.cards.map((c) => c.id)).toEqual(first.cards.map((c) => c.id));
		expect(await openRounds()).toHaveLength(1);
	});

	it('opens one round when several loads race', async () => {
		const rounds = await Promise.all(
			Array.from({ length: 6 }, () => repo.startRound(userId, deck, at(0)))
		);
		expect(new Set(rounds.map((r) => r!.assessmentId)).size).toBe(1);
		expect(await openRounds()).toHaveLength(1);
	});

	it('returns the ratings logged so far, per card, in attempt order', async () => {
		const r = (await repo.startRound(userId, deck, at(0)))!;
		const [a, b] = r.cards;
		await repo.recordGrade(userId, r.assessmentId, a.id, 1, 0, at(0.1));
		await repo.recordGrade(userId, r.assessmentId, b.id, 3, 0, at(0.2));
		await repo.recordGrade(userId, r.assessmentId, a.id, 3, 1, at(0.3));
		const resumed = (await repo.startRound(userId, deck, at(0.5)))!;
		expect(resumed.progress).toEqual({ [a.id]: [1, 3], [b.id]: [3] });
	});

	it('refuses a grade for a card that is not in the round', async () => {
		const r = (await repo.startRound(userId, deck, at(0)))!;
		await db
			.update(table.assessment)
			.set({ cardIds: [r.cards[0].id] })
			.where(eq(table.assessment.id, r.assessmentId));
		expect(await repo.recordGrade(userId, r.assessmentId, r.cards[1].id, 3, 0, at(0.1))).toBeNull();
		expect(await repo.recordGrade(userId, r.assessmentId, r.cards[0].id, 3, 0, at(0.1))).toBe(3);
	});

	it('opens a new round once the last one is finished', async () => {
		const r = (await repo.startRound(userId, deck, at(0)))!;
		for (const c of r.cards) await repo.recordGrade(userId, r.assessmentId, c.id, 3, 0, at(0.1));
		expect(await repo.finishRound(userId, r.assessmentId, at(0.2))).not.toBeNull();
		const next = (await repo.startRound(userId, deck, at(0.3)))!;
		expect(next.assessmentId).not.toBe(r.assessmentId);
		expect(next.progress).toEqual({});
	});

	it('grades a stale round that has grades and deletes one that has none', async () => {
		const graded = (await repo.startRound(userId, deck, at(0)))!;
		await repo.recordGrade(userId, graded.assessmentId, graded.cards[0].id, 1, 0, at(0.1));
		const fresh = (await repo.startRound(userId, deck, at(13)))!;
		expect(fresh.assessmentId).not.toBe(graded.assessmentId);
		const [closed] = await db
			.select()
			.from(table.assessment)
			.where(eq(table.assessment.id, graded.assessmentId));
		// Closed at its last grade, not at the moment it was found stale.
		expect(closed.finishedAt).toEqual(at(0.1));
		expect(closed.score).toBe(0);

		const next = (await repo.startRound(userId, deck, at(26)))!;
		expect(next.assessmentId).not.toBe(fresh.assessmentId);
		const ids = (await openRounds()).map((a) => a.id);
		expect(ids).not.toContain(fresh.assessmentId);
	});

	it('closes extra open rounds oldest first, carrying standing in order', async () => {
		// Two open rounds for one deck, as rounds opened before resume existed left them.
		const open = async (id: string, h: number, card: string, rating: number) => {
			await db.insert(table.assessment).values({
				id,
				userId,
				deck,
				startedAt: at(h),
				cardIds: [card]
			});
			await repo.recordGrade(userId, id, card, rating as 1 | 3, 0, at(h + 0.1));
		};
		await open(`${run}-old`, 0, `${run}-n0`, 1); // even: missed
		await open(`${run}-new`, 1, `${run}-n2`, 3); // even: recalled
		await repo.startRound(userId, deck, at(20));
		const rows = await openRounds();
		const newer = rows.find((a) => a.id === `${run}-new`)!;
		// Closed second, so its standing holds both: 0.75 * miss + hit.
		expect(newer.finishedAt).toEqual(at(1.1));
		expect(newer.standing).toEqual([{ tag: 'even', cards: 1.75, credit: 1 }]);
	});

	it('carries a weak tag into the next round when that round does not test it', async () => {
		const pick = async (h: number, ids: string[]) => {
			const r = (await repo.startRound(userId, deck, at(h)))!;
			await db
				.update(table.assessment)
				.set({ cardIds: ids })
				.where(eq(table.assessment.id, r.assessmentId));
			return r.assessmentId;
		};
		const r1 = await pick(0, [`${run}-n0`]);
		await repo.recordGrade(userId, r1, `${run}-n0`, 1, 0, at(0.1));
		expect((await repo.finishRound(userId, r1, at(0.2)))!.weak).toEqual(['even']);

		const r2 = await pick(1, [`${run}-n1`]);
		await repo.recordGrade(userId, r2, `${run}-n1`, 3, 0, at(1.1));
		const g = (await repo.finishRound(userId, r2, at(1.2)))!;
		expect(g.areas.map((a) => a.tag)).toEqual(['odd']);
		expect(g.weak).toEqual(['even']);
	});

	it('logs the state each card was in before it was graded', async () => {
		const r = (await repo.startRound(userId, deck, at(0)))!;
		const id = r.cards[0].id;
		await repo.recordGrade(userId, r.assessmentId, id, 1, 0, at(0.1));
		await repo.recordGrade(userId, r.assessmentId, id, 3, 1, at(0.2));
		const logs = await db
			.select({ state: table.reviewLog.state })
			.from(table.reviewLog)
			.where(eq(table.reviewLog.nodeId, id))
			.orderBy(table.reviewLog.id);
		expect(logs.map((l) => l.state)).toEqual([0, 1]);
	});

	it("stops introducing new cards once the day's allowance is spent", async () => {
		const { NEW_PER_DAY } = await import('./select');
		await db.insert(table.node).values(
			Array.from({ length: NEW_PER_DAY + 10 }, (_, i) => ({
				id: `${run}-x${i}`,
				userId,
				deck,
				front: `x${i}`,
				tags: ['x']
			}))
		);
		const first = (await repo.startRound(userId, deck, at(0)))!;
		expect(first.cards).toHaveLength(NEW_PER_DAY);
		for (const c of first.cards)
			await repo.recordGrade(userId, first.assessmentId, c.id, 3, 0, at(0.1));
		await repo.finishRound(userId, first.assessmentId, at(0.2));

		// Same UTC day: only cards already introduced come back.
		const second = (await repo.startRound(userId, deck, at(0.5)))!;
		const introduced = new Set(first.cards.map((c) => c.id));
		expect(second.cards.every((c) => introduced.has(c.id))).toBe(true);
		for (const c of second.cards)
			await repo.recordGrade(userId, second.assessmentId, c.id, 3, 0, at(0.6));
		await repo.finishRound(userId, second.assessmentId, at(0.7));

		// Next UTC day: new cards again.
		const third = (await repo.startRound(userId, deck, at(24)))!;
		expect(third.cards.some((c) => !introduced.has(c.id))).toBe(true);
	});
});

describe.skipIf(!hasDb)('importDeck against the database', () => {
	const run = crypto.randomUUID().slice(0, 8);
	const userId = `test-import-${run}`;
	async function cleanup() {
		await db.delete(table.node).where(eq(table.node.userId, userId));
		await db.delete(table.user).where(eq(table.user.id, userId));
	}
	beforeEach(async () => {
		await cleanup();
		await db.insert(table.user).values({ id: userId, email: `${userId}@test.invalid` });
	});
	afterAll(cleanup);

	it('imports an export that repeats a note, keeping the last copy', async () => {
		const raw = [
			'#separator:tab',
			'#html:true',
			'#guid column:1',
			'#deck column:2',
			'#tags column:5',
			'g1\tD\tfront one\tback one\ta',
			'g2\tD\tfront two\tback two\tb',
			'g1\tD\tfront one\tback edited\ta'
		].join('\n');
		const res = await repo.importDeck(userId, raw);
		expect(res.imported).toBe(2);
		expect(res.warnings.some((w) => /repeat/i.test(w))).toBe(true);
		const rows = await db
			.select()
			.from(table.node)
			.where(and(eq(table.node.userId, userId), eq(table.node.kind, 'card')));
		expect(rows.map((r) => r.back).sort()).toEqual(['back edited', 'back two']);
	});
});
