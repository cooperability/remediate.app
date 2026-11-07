import { json, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import * as auth from '$lib/server/auth';
import { asTenant } from '$lib/server/db';
import { isAllowed } from '$lib/server/otp';
import { toTheme } from '$lib/theme';

const PUBLIC = ['/', '/login', '/demo', '/api/health', '/theme'];

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(auth.sessionCookieName);
	let lookup: Awaited<ReturnType<typeof auth.validateSessionToken>> | undefined;
	if (token) {
		try {
			lookup = await auth.validateSessionToken(token);
		} catch (error) {
			// Off the public pages a failure stays a failure: signing everyone out would hide
			// a broken query behind a login loop. A POST (logout) must not report success
			// either, since it could not revoke the session. /theme only sets a cookie.
			const readOnly = event.request.method === 'GET' || event.request.method === 'HEAD';
			const safe = readOnly || event.url.pathname === '/theme';
			if (!PUBLIC.includes(event.url.pathname) || !safe) throw error;
			// A database outage must not take down public pages. Signed out is fail-closed, and
			// the cookie stays so the session works again once the database is back. The query
			// error carries the SQL and the session id, so only the driver's cause is logged.
			const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
			// A localhost host gives an AggregateError with an empty message and the code alone.
			const reason = cause?.message || (cause as { code?: string } | null)?.code || 'unknown';
			console.error(`[auth] session lookup failed, rendering signed out: ${reason}`);
		}
	}
	if (token && lookup) {
		let { session, user } = lookup;
		// Dropping an address from ALLOWED_EMAILS ends its sessions on the next request.
		// A demo guest has no address to allow: its session ends at guestExpiresAt.
		if (session && user && !user.guestExpiresAt && !isAllowed(user.email)) {
			await auth.invalidateSession(session.id);
			session = null;
			user = null;
		}
		if (session) auth.setSessionTokenCookie(event, token, session.expiresAt);
		else auth.deleteSessionTokenCookie(event);
		event.locals.user = user;
		event.locals.session = session;
	} else {
		event.locals.user = null;
		event.locals.session = null;
	}

	if (!event.locals.user && !PUBLIC.includes(event.url.pathname)) {
		// A fetch follows a redirect to the login page's HTML and then fails to parse
		// it. API callers get a status they can act on.
		if (event.url.pathname.startsWith('/api/')) {
			return json({ message: 'Log in again.' }, { status: 401 });
		}
		redirect(303, '/login');
	}
	// Harvest fetches arbitrary URLs from the server: not for anonymous visitors. The
	// matched route, not the raw path: /%68arvest routes to /harvest too.
	if (event.locals.user?.guestExpiresAt && event.route.id?.startsWith('/harvest')) {
		redirect(303, '/cards');
	}

	// Rendered server-side so the first paint is right: the CSP forbids an inline script.
	const theme = toTheme(event.cookies.get('theme'));
	const render = async () =>
		resolve(event, { transformPageChunk: ({ html }) => html.replace('%theme%', theme) });
	// Signed-in work runs under row-level security for that user (db/index.ts).
	const user = event.locals.user;
	return user ? asTenant(user.id, render) : render();
};
