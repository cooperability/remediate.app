import { redirect } from '@sveltejs/kit';
import * as auth from '$lib/server/auth';
import { startGuest } from '$lib/server/guest';
import type { RequestHandler } from './$types';

/** The landing page's "Try the demo" form. SvelteKit's origin check covers this POST. */
export const POST: RequestHandler = async (event) => {
	if (event.locals.user) redirect(303, '/cards');
	const started = await startGuest(event.getClientAddress());
	if (!started.ok) redirect(303, `/?demo=${started.reason}`);
	const token = auth.generateSessionToken();
	const session = await auth.createSession(token, started.userId, started.expiresAt);
	auth.setSessionTokenCookie(event, token, session.expiresAt);
	redirect(303, '/cards');
};
