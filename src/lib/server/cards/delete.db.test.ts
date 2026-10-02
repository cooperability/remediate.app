import { hasDb } from '../testing/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as table from '../db/schema';

const { db, asTenant } = hasDb ? await import('../db') : ({} as typeof import('../db'));
const repo = hasDb ? await import('./repo') : ({} as typeof import('./repo'));

describe.skipIf(!hasDb)('deleteDeck', () => {
	const run = crypto.randomUUID().slice(0, 8);
	const userId = `test-user-${run}`;
	const other = `test-other-${run}`;
	const deck = `test-deck-${run}`;

	async function cleanup() {
		for (const u of [userId, other]) {
			await db.delete(table.reviewLog).where(eq(table.reviewLog.userId, u));
			await db.delete(table.reviewState).where(eq(table.reviewState.userId, u));
			await db.delete(table.assessment).where(eq(table.assessment.userId, u));
			await db.delete(table.harvest).where(eq(table.harvest.userId, u));
			await db.delete(table.node).where(eq(table.node.userId, u));
			await db.delete(table.user).where(eq(table.user.id, u));
		}
	}
	const card = (u: string, i: number, d = deck) => ({
		id: `${run}-${u === userId ? 'a' : 'b'}${i}-${d}`,
		userId: u,
		deck: d,
		front: `f${i}`,
		back: `b${i}`
	});

	beforeEach(async () => {
		await cleanup();
		for (const u of [userId, other])
			await db.insert(table.user).values({ id: u, email: `${u}@test.invalid` });
		await db
			.insert(table.node)
			.values([card(userId, 0), card(userId, 1), card(userId, 2, 'keep'), card(other, 0)]);
	});
	afterAll(cleanup);

	it('removes the deck, its schedules, logs and rounds, and nothing else', async () => {
		const r = (await repo.startRound(userId, deck))!;
		await repo.recordGrade(userId, r.assessmentId, r.cards[0].id, 3, 0);
		await repo.finishRound(userId, r.assessmentId);
		await db.insert(table.harvest).values({
			userId,
			urlNormalized: 'https://a.test/x',
			status: 'accepted',
			nodeId: card(userId, 1).id
		});

		const n = await asTenant(userId, () => repo.deleteDeck(userId, deck));
		expect(n).toBe(2);

		const nodes = await db.select({ id: table.node.id }).from(table.node);
		const ids = nodes.map((x) => x.id);
		expect(ids).not.toContain(card(userId, 0).id);
		expect(ids).toContain(card(userId, 2, 'keep').id);
		expect(ids).toContain(card(other, 0).id);
		expect(
			await db.select().from(table.reviewLog).where(eq(table.reviewLog.userId, userId))
		).toEqual([]);
		expect(
			await db.select().from(table.assessment).where(eq(table.assessment.userId, userId))
		).toEqual([]);
		const [h] = await db.select().from(table.harvest).where(eq(table.harvest.userId, userId));
		expect(h).toMatchObject({ status: 'ready', nodeId: null });
	});

	it("cannot touch another user's deck of the same name", async () => {
		const n = await asTenant(other, () => repo.deleteDeck(other, deck));
		expect(n).toBe(1);
		const mine = await db.select().from(table.node).where(eq(table.node.userId, userId));
		expect(mine).toHaveLength(3);
	});

	it('leaves nodes of other kinds that carry the deck name', async () => {
		const hall = { ...card(userId, 9), kind: 'concept', notetype: 'deck' };
		await db.insert(table.node).values(hall);
		expect(await asTenant(userId, () => repo.deleteDeck(userId, deck))).toBe(2);
		const [left] = await db.select().from(table.node).where(eq(table.node.id, hall.id));
		expect(left?.kind).toBe('concept');
	});

	it('returns 0 for a deck that does not exist', async () => {
		expect(await asTenant(userId, () => repo.deleteDeck(userId, 'nope'))).toBe(0);
	});
});
