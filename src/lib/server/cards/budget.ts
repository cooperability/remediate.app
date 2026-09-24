import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { NEW_PER_DAY } from './select';

// The daily new-card allowance (select.ts NEW_PER_DAY), per deck, in the user's
// time zone. Cards and Quest draw on the same allowance: it exists to protect
// tomorrow's review load, and a card met in Quest brings the same future reviews
// as one met in a round.

/** A card is introduced on the day of its first ever review, whichever surface it was on. */
const firstReviewToday = (userId: string, now: Date, tz: string) =>
	and(
		eq(table.reviewLog.userId, userId),
		eq(table.reviewLog.state, 0),
		sql`(${table.reviewLog.reviewedAt} at time zone ${tz})::date = (${now.toISOString()}::timestamptz at time zone ${tz})::date`
	);

/** Cards in the deck whose first ever review fell on today, in time zone `tz`. */
export async function introducedToday(userId: string, deck: string, now: Date, tz: string) {
	const [{ n }] = await db
		.select({ n: sql<number>`count(distinct ${table.reviewLog.nodeId})::int` })
		.from(table.reviewLog)
		.innerJoin(table.node, eq(table.node.id, table.reviewLog.nodeId))
		.where(and(firstReviewToday(userId, now, tz), eq(table.node.deck, deck)));
	return n;
}

/** New cards each deck may still introduce today. Decks with nothing introduced are absent: read them as NEW_PER_DAY. */
export async function newLeftByDeck(userId: string, now: Date, tz: string) {
	const rows = await db
		.select({
			deck: table.node.deck,
			n: sql<number>`count(distinct ${table.reviewLog.nodeId})::int`
		})
		.from(table.reviewLog)
		.innerJoin(table.node, eq(table.node.id, table.reviewLog.nodeId))
		.where(firstReviewToday(userId, now, tz))
		.groupBy(table.node.deck);
	return new Map(rows.map((r) => [r.deck, Math.max(0, NEW_PER_DAY - r.n)]));
}
