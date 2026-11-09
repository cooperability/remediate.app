import { beforeEach, describe, expect, it, vi } from 'vitest';

// No database here: the session lookup fails the way drizzle reports an outage, with
// the query and its params in the message and the driver error as the cause.
vi.mock('$lib/server/db', () => ({
	db: {},
	asTenant: vi.fn(async () => {
		throw new Error('asTenant must not run for a signed-out request');
	})
}));
vi.mock('$lib/server/auth', () => ({
	sessionCookieName: 'auth-session',
	validateSessionToken: vi.fn(async () => {
		throw new Error('Failed query: select ... from "session"\nparams: 5e55107dea5e', {
			cause: new Error('connect ECONNREFUSED 127.0.0.1:5432')
		});
	}),
	invalidateSession: vi.fn(),
	setSessionTokenCookie: vi.fn(),
	deleteSessionTokenCookie: vi.fn()
}));

// Read when the hook's modules load, below.
process.env.ALLOWED_EMAILS = 'me@test.invalid';
const auth = await import('$lib/server/auth');
const { handle } = await import('../../hooks.server');

/** `route` is the id SvelteKit matched, which a percent-encoded path can hide from `url`. */
function event(path: string, method = 'GET', route: string | null = null) {
	return {
		url: new URL(`http://localhost${path}`),
		route: { id: route },
		request: new Request(`http://localhost${path}`, { method }),
		cookies: {
			get: (name: string) => (name === 'auth-session' ? 'stale-token' : undefined),
			set: () => {},
			delete: () => {}
		},
		locals: {} as Record<string, unknown>
	} as unknown as Parameters<typeof handle>[0]['event'];
}

describe('auth hook when the session lookup throws', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('still renders the public landing page, signed out', async () => {
		const e = event('/');
		const resolve = vi.fn(async () => new Response('page'));
		const res = await handle({ event: e, resolve });
		expect(resolve).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('page');
		expect(e.locals.user).toBeNull();
		expect(e.locals.session).toBeNull();
		expect(auth.deleteSessionTokenCookie).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledOnce();
	});

	// The query error carries the session id (a hash of the token) and the SQL.
	it('logs the cause only, never the token, query or params', async () => {
		await handle({ event: event('/'), resolve: async () => new Response('page') });
		const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
		expect(logged).toContain('ECONNREFUSED');
		expect(logged).not.toContain('stale-token');
		expect(logged).not.toContain('5e55107dea5e');
		expect(logged).not.toContain('select');
	});

	// Signing out every user would hide a broken query behind a login loop. Outside the
	// public pages the failure stays a failure.
	it('rethrows on pages that need a session', async () => {
		const resolve = vi.fn(async () => new Response('page'));
		await expect(handle({ event: event('/cards'), resolve })).rejects.toThrow('Failed query');
		expect(resolve).not.toHaveBeenCalled();
	});

	// A localhost URL makes node try ::1 and 127.0.0.1: the cause is an AggregateError
	// with an empty message and the code on the error itself.
	it('logs the error code when the cause has no message', async () => {
		vi.mocked(auth.validateSessionToken).mockRejectedValueOnce(
			new Error('Failed query', {
				cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
			})
		);
		await handle({ event: event('/'), resolve: async () => new Response('page') });
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('ECONNREFUSED');
	});

	// Logging out posts to /login. Rendering it signed out would clear the cookie and
	// report success while the session row lives on.
	it('rethrows on a public path when the request changes state', async () => {
		const resolve = vi.fn(async () => new Response('page'));
		await expect(handle({ event: event('/login?/logout', 'POST'), resolve })).rejects.toThrow(
			'Failed query'
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	// Uptime checkers send HEAD. Switching theme never touches the database.
	it('renders HEAD requests and theme changes signed out', async () => {
		for (const [path, method] of [
			['/api/health', 'HEAD'],
			['/theme', 'POST']
		]) {
			const resolve = vi.fn(async () => new Response('ok'));
			const res = await handle({ event: event(path, method), resolve });
			expect(await res.text(), `${method} ${path}`).toBe('ok');
		}
	});

	it('rethrows on API routes', async () => {
		const resolve = vi.fn(async () => new Response('page'));
		await expect(handle({ event: event('/api/review/grade'), resolve })).rejects.toThrow(
			'Failed query'
		);
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('auth hook for a demo guest', () => {
	const guestExpiresAt = new Date(Date.now() + 60_000);
	const lookup = {
		user: { id: 'g1', email: 'guest-g1@guest.invalid', guestExpiresAt },
		session: { id: 's1', userId: 'g1', expiresAt: guestExpiresAt }
	};
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(auth.validateSessionToken).mockResolvedValueOnce(lookup);
		const { asTenant } = await import('$lib/server/db');
		vi.mocked(asTenant).mockImplementationOnce(async (_id, fn) => fn());
	});

	// No allowlist names a guest address: the allowlist check must not sign it out.
	it('keeps the guest signed in on app pages', async () => {
		const e = event('/cards');
		const res = await handle({ event: e, resolve: async () => new Response('page') });
		expect(await res.text()).toBe('page');
		expect(e.locals.user).toEqual(lookup.user);
		expect(auth.invalidateSession).not.toHaveBeenCalled();
	});

	it('sends the guest from harvest back to the decks, however the path is spelled', async () => {
		// beforeEach queued the first lookup.
		vi.mocked(auth.validateSessionToken).mockResolvedValueOnce(lookup);
		for (const path of ['/harvest', '/%68arvest?/queue']) {
			await expect(
				handle({
					event: event(path, 'GET', '/harvest'),
					resolve: async () => new Response('page')
				}),
				path
			).rejects.toMatchObject({ status: 303, location: '/cards' });
		}
	});
});

describe('auth hook for a real user', () => {
	const expiresAt = new Date(Date.now() + 60_000);
	const as = (email: string) => ({
		user: { id: 'u1', email, guestExpiresAt: null },
		session: { id: 's1', userId: 'u1', expiresAt }
	});
	beforeEach(async () => {
		vi.clearAllMocks();
		const { asTenant } = await import('$lib/server/db');
		vi.mocked(asTenant).mockImplementationOnce(async (_id, fn) => fn());
	});

	it('reaches harvest when allowlisted', async () => {
		vi.mocked(auth.validateSessionToken).mockResolvedValueOnce(as('me@test.invalid'));
		const res = await handle({
			event: event('/harvest', 'GET', '/harvest'),
			resolve: async () => new Response('page')
		});
		expect(await res.text()).toBe('page');
		expect(auth.invalidateSession).not.toHaveBeenCalled();
	});

	it('is signed out once dropped from the allowlist', async () => {
		vi.mocked(auth.validateSessionToken).mockResolvedValueOnce(as('gone@test.invalid'));
		await expect(
			handle({ event: event('/cards'), resolve: async () => new Response('page') })
		).rejects.toMatchObject({ status: 303, location: '/login' });
		expect(auth.invalidateSession).toHaveBeenCalledWith('s1');
	});
});
