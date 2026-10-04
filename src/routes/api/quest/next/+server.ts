import { error, json } from '@sveltejs/kit';
import { refusal } from '$lib/server/quest/http';
import { nextEncounter } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { RequestHandler } from './$types';

/** Walk to the next encounter worth having and open it: { encounter, view }. */
export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user) error(401);
	const r = await nextEncounter(locals.user.id, new Date(), toTimeZone(cookies.get(TZ_COOKIE)));
	return r.ok ? json({ encounter: r.encounter, view: r.view }) : refusal(r.reason);
};
