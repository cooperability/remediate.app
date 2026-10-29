import { hasDb } from './testing/db';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

vi.mock('$lib/server/cards/repo', () => ({
	importDeck: async () => {
		throw new Error('import failed');
	}
}));

const { db } = hasDb ? await import('./db') : ({} as typeof import('./db'));
const table = hasDb ? await import('./db/schema') : ({} as typeof import('./db/schema'));
const guest = hasDb ? await import('./guest') : ({} as typeof import('./guest'));

describe.skipIf(!hasDb)('a guest whose import fails', () => {
	afterAll(() => db.delete(table.guestThrottle));

	// Otherwise it holds one of MAX_GUESTS slots for 24 hours with nothing in it.
	it('leaves no user row behind', async () => {
		const guests = () => db.$count(table.user, like(table.user.email, 'guest-%@guest.invalid'));
		const before = await guests();
		await expect(guest.startGuest('198.51.100.200')).rejects.toThrow('import failed');
		expect(await guests()).toBe(before);
	});
});
