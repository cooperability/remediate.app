import { isIPv6 } from 'node:net';
import { and, count, eq, gt, inArray, isNotNull, lte, lt, sql } from 'drizzle-orm';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCase, encodeHexLowerCase } from '@oslojs/encoding';
import { asTenant, db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { importDeck } from '$lib/server/cards/repo';
import software from '../../../source_data/Software Knowledge (AI-made).txt?raw';
import finance from '../../../source_data/Personal Finance and Career Growth (AI-made).txt?raw';

// Signed-out demo. Each visitor gets a throwaway tenant holding the two AI-made
// decks, so Cards, Browse and Quest run unchanged under the same RLS. No cron:
// every start purges the guests that have expired.

export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Live guests at once. Bounds the rows anonymous traffic can hold. */
export const MAX_GUESTS = 100;
/** Guests one client address may start per window. */
export const MAX_STARTS_PER_IP = 5;
const windowStart = sql`now() - interval '1 hour'`;
/**
 * Expired guests one start purges. Each start adds one guest, so the backlog still
 * drains, and no visitor waits on a purge of every guest that expired at once.
 */
export const PURGE_BATCH = 10;

/** Tables holding a guest's rows, children before the parents they reference. */
const OWNED = [
	table.reviewLog,
	table.reviewState,
	table.questRun,
	table.harvest,
	table.cardTrash,
	table.job,
	table.assessment,
	table.edge,
	table.node,
	table.session
] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Delete up to PURGE_BATCH expired guests and everything they own. */
export async function purgeExpiredGuests(tx: Tx): Promise<number> {
	const ids = (
		await tx
			.select({ id: table.user.id })
			.from(table.user)
			.where(and(isNotNull(table.user.guestExpiresAt), lte(table.user.guestExpiresAt, sql`now()`)))
			.limit(PURGE_BATCH)
	).map((r) => r.id);
	if (!ids.length) return 0;
	for (const t of OWNED) await tx.delete(t).where(inArray(t.userId, ids));
	await tx.delete(table.user).where(inArray(table.user.id, ids));
	return ids.length;
}

/**
 * The throttle's key for an address. One IPv6 subscriber holds a whole /64, so
 * keying the full address would let one network fill the cap.
 */
export function throttleKey(ip: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1];
	if (!isIPv6(ip)) return ip;
	const [head, tail = ''] = ip.toLowerCase().split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	return `${groups
		.slice(0, 4)
		.map((g) => g.replace(/^0+(?=.)/, ''))
		.join(':')}::/64`;
}

/**
 * Takes one guest start for `ip` and says whether it may proceed. Only a hash of
 * the address is stored. Counted before any other work, as the login throttle is.
 */
export async function takeGuestStart(ip: string): Promise<boolean> {
	const ipHash = encodeHexLowerCase(sha256(new TextEncoder().encode(throttleKey(ip))));
	const t = table.guestThrottle;
	await db.delete(t).where(lt(t.windowStart, windowStart));
	const [row] = await db
		.insert(t)
		.values({ ipHash, windowStart: sql`now()`, starts: 1 })
		.onConflictDoUpdate({ target: t.ipHash, set: { starts: sql`${t.starts} + 1` } })
		.returning({ starts: t.starts });
	return row.starts <= MAX_STARTS_PER_IP;
}

export type GuestStart =
	{ ok: true; userId: string; expiresAt: Date } | { ok: false; reason: 'throttled' | 'full' };

/** Create a guest holding the AI-made decks. The caller makes its session. */
export async function startGuest(ip: string): Promise<GuestStart> {
	if (!(await takeGuestStart(ip))) return { ok: false, reason: 'throttled' };
	const id = encodeBase32LowerCase(crypto.getRandomValues(new Uint8Array(15)));
	const expiresAt = new Date(Date.now() + GUEST_TTL_MS);
	const created = await db.transaction(async (tx) => {
		// One starter at a time, so parallel starts cannot each pass the cap check.
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('guest-start', 0))`);
		await purgeExpiredGuests(tx);
		const [{ live }] = await tx
			.select({ live: count() })
			.from(table.user)
			.where(gt(table.user.guestExpiresAt, sql`now()`));
		if (live >= MAX_GUESTS) return false;
		// .invalid never resolves (RFC 2606), and no allowlist names it.
		await tx
			.insert(table.user)
			.values({ id, email: `guest-${id}@guest.invalid`, guestExpiresAt: expiresAt });
		return true;
	});
	if (!created) return { ok: false, reason: 'full' };
	// The same import path and RLS a signed-in upload takes.
	try {
		await asTenant(id, async () => {
			await importDeck(id, software);
			await importDeck(id, finance);
		});
	} catch (e) {
		// The import rolled back, so the user row is all there is. It must not hold a slot.
		await db.delete(table.user).where(eq(table.user.id, id));
		throw e;
	}
	return { ok: true, userId: id, expiresAt };
}
