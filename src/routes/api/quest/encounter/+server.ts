import { error, json } from '@sveltejs/kit';
import { refusal, targetOf } from '$lib/server/quest/http';
import { openEncounter } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { RequestHandler } from './$types';

/** Try a locked door. The card behind it is the encounter; grade it at /api/review/grade. */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) error(401);
	const to = await targetOf(request);
	if (!to) error(400, 'Say which door.');
	const r = await openEncounter(locals.user.id, to, new Date(), toTimeZone(cookies.get(TZ_COOKIE)));
	return r.ok ? json(r.encounter) : refusal(r.reason);
};
