import { error, json } from '@sveltejs/kit';
import { refusal, targetOf } from '$lib/server/quest/http';
import { move } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { RequestHandler } from './$types';

/** Walk through an open door, or fast-travel across known ground. */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) error(401);
	const to = await targetOf(request);
	if (!to) error(400, 'Say where to.');
	const r = await move(locals.user.id, to, new Date(), toTimeZone(cookies.get(TZ_COOKIE)));
	return r.ok ? json(r.view) : refusal(r.reason);
};
