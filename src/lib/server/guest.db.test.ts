import { hasDb } from './testing/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { sha256 } from '@oslojs/crypto/sha2';

const { db } = hasDb ? await import('./db') : ({} as typeof import('./db'));
const table = hasDb ? await import('./db/schema') : ({} as typeof import('./db/schema'));
const guest = hasDb ? await import('./guest') : ({} as typeof import('./guest'));
const auth = hasDb ? await import('./auth') : ({} as typeof import('./auth'));

/** Every guest this file made, and the throttle rows its addresses left. */
async function cleanup() {
	const ids = (
		await db
			.select({ id: table.user.id })
			.from(table.user)
			.where(like(table.user.email, 'guest-%@guest.invalid'))
	).map((r) => r.id);
	if (ids.length) {
		await db
			.update(table.user)
			.set({ guestExpiresAt: new Date(0) })
			.where(inArray(table.user.id, ids));
		while (await db.transaction((tx) => guest.purgeExpiredGuests(tx)));
	}
	await db.delete(table.guestThrottle);
}

let ip = 0;
const nextIp = () => `203.0.113.${++ip}`;

async function start() {
	const r = await guest.startGuest(nextIp());
	if (!r.ok) throw new Error(`guest refused: ${r.reason}`);
	return r;
}

describe.skipIf(!hasDb)('demo guests', () => {
	beforeEach(cleanup);
	afterAll(cleanup);

	it('seeds the two AI-made decks and nothing else', async () => {
		const { userId, expiresAt } = await start();
		const decks = await db
			.select({ deck: table.node.deck, n: sql<number>`count(*)::int` })
			.from(table.node)
			.where(sql`${table.node.userId} = ${userId} and ${table.node.kind} = 'card'`)
			.groupBy(table.node.deck)
			.orderBy(table.node.deck);
		// Card counts from source_data/README.md.
		expect(decks).toEqual([
			{ deck: 'Personal Finance and Career Growth (AI-made)', n: 149 },
			{ deck: 'Software Knowledge (AI-made)', n: 184 }
		]);
		const ms = expiresAt.getTime() - Date.now();
		expect(ms).toBeGreaterThan(guest.GUEST_TTL_MS - 60_000);
		expect(ms).toBeLessThanOrEqual(guest.GUEST_TTL_MS);
	});

	it('throttles one address past its limit, and not another', async () => {
		const addr = nextIp();
		for (let i = 0; i < guest.MAX_STARTS_PER_IP; i++) {
			expect((await guest.startGuest(addr)).ok).toBe(true);
		}
		expect(await guest.startGuest(addr)).toEqual({ ok: false, reason: 'throttled' });
		expect((await guest.startGuest(nextIp())).ok).toBe(true);
	});

	it('counts every address in one IPv6 /64 against one limit', async () => {
		for (let i = 1; i <= guest.MAX_STARTS_PER_IP; i++) {
			expect(await guest.takeGuestStart(`2001:db8:1:2::${i}`)).toBe(true);
		}
		expect(await guest.takeGuestStart('2001:db8:1:2:ffff::9')).toBe(false);
		expect(await guest.takeGuestStart('2001:db8:1:3::1')).toBe(true);
	});

	it('stores a hash of the address, never the address', async () => {
		const addr = nextIp();
		await guest.takeGuestStart(addr);
		const rows = await db.select().from(table.guestThrottle);
		expect(rows.map((r) => r.ipHash)).toEqual([
			encodeHexLowerCase(sha256(new TextEncoder().encode(addr)))
		]);
	});

	it('refuses a new guest once MAX_GUESTS are live', async () => {
		const later = new Date(Date.now() + 60_000);
		await db.insert(table.user).values(
			Array.from({ length: guest.MAX_GUESTS }, (_, i) => ({
				id: `cap-${i}`,
				email: `guest-cap-${i}@guest.invalid`,
				guestExpiresAt: later
			}))
		);
		expect(await guest.startGuest(nextIp())).toEqual({ ok: false, reason: 'full' });
	});

	it('expired guests free their slots, and one start purges a bounded batch', async () => {
		await db.insert(table.user).values(
			Array.from({ length: guest.MAX_GUESTS }, (_, i) => ({
				id: `old-${i}`,
				email: `guest-old-${i}@guest.invalid`,
				guestExpiresAt: new Date(Date.now() - 1000)
			}))
		);
		expect((await guest.startGuest(nextIp())).ok).toBe(true);
		const left = await db.$count(table.user, like(table.user.id, 'old-%'));
		expect(left).toBe(guest.MAX_GUESTS - guest.PURGE_BATCH);
	});

	it('purges every row an expired guest owns, in every user_id table', async () => {
		const { userId } = await start();
		const live = await start();
		const liveNodes = () => db.$count(table.node, eq(table.node.userId, live.userId));
		const before = await liveNodes();
		await auth.createSession(auth.generateSessionToken(), userId, new Date(Date.now() + 1000));
		const [card] = await db
			.select({ id: table.node.id })
			.from(table.node)
			.where(sql`${table.node.userId} = ${userId} and ${table.node.kind} = 'card'`)
			.limit(1);
		// A row in every table the guest can own, children with their parents, so a
		// table dropped from the purge, or deleted out of order, fails below.
		await db.insert(table.reviewState).values({ nodeId: card.id, userId, due: new Date() });
		await db.insert(table.questRun).values({ id: `run-${userId}`, userId, currentNodeId: card.id });
		await db.insert(table.assessment).values({ id: `round-${userId}`, userId, deck: 'd' });
		await db.insert(table.reviewLog).values({
			userId,
			nodeId: card.id,
			rating: 3,
			surface: 'cards',
			assessmentId: `round-${userId}`
		});
		await db
			.insert(table.harvest)
			.values({ userId, urlNormalized: 'https://example.com/', nodeId: card.id });
		await db.insert(table.cardTrash).values({ id: `trash-${userId}`, userId, payload: {} });
		await db.insert(table.job).values({ userId, kind: 'extract' });

		await db
			.update(table.user)
			.set({ guestExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(table.user.id, userId));
		expect(await db.transaction((tx) => guest.purgeExpiredGuests(tx))).toBe(1);

		// From the catalog, so a table added later that this purge misses fails here.
		const tables = await db.execute<{ table_name: string }>(
			sql`select table_name from information_schema.columns
				where table_schema = 'public' and column_name = 'user_id'`
		);
		expect(tables.length).toBeGreaterThan(5);
		for (const { table_name } of tables) {
			const [{ n }] = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from ${sql.identifier(table_name)} where user_id = ${userId}`
			);
			expect({ table_name, n }).toEqual({ table_name, n: 0 });
		}
		expect(await db.select().from(table.user).where(eq(table.user.id, userId))).toEqual([]);
		// A guest still inside its 24 hours keeps everything.
		expect(before).toBeGreaterThan(333);
		expect(await liveNodes()).toBe(before);
	});

	it('never renews a guest session past the guest', async () => {
		const { userId, expiresAt } = await start();
		const token = auth.generateSessionToken();
		await auth.createSession(token, userId, expiresAt);
		// Well inside the 15-day window where a normal session renews to 30 days.
		const { session, user } = await auth.validateSessionToken(token);
		expect(user?.guestExpiresAt).toEqual(expiresAt);
		expect(session?.expiresAt).toEqual(expiresAt);
		const [row] = await db
			.select({ expiresAt: table.session.expiresAt })
			.from(table.session)
			.where(eq(table.session.userId, userId));
		expect(row.expiresAt).toEqual(expiresAt);
	});
});

describe.skipIf(!hasDb)('a real user session', () => {
	const id = 'guest-test-real-user';
	afterAll(async () => {
		await db.delete(table.session).where(eq(table.session.userId, id));
		await db.delete(table.user).where(eq(table.user.id, id));
	});

	// The guest change must leave the 30-day sliding session as it was.
	it('still renews to 30 days inside the last 15', async () => {
		await db.insert(table.user).values({ id, email: 'real-user@test.invalid' });
		const token = auth.generateSessionToken();
		await auth.createSession(token, id, new Date(Date.now() + 24 * 60 * 60 * 1000));
		const { session } = await auth.validateSessionToken(token);
		const days = (session!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
		expect(days).toBeGreaterThan(29.9);
	});
});
