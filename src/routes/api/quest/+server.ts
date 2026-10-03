import { error, json } from '@sveltejs/kit';
import { questView } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { RequestHandler } from './$types';

/** The player's current room and map (PRD §3.3 GET /api/quest/room). */
export const GET: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user) error(401);
	const view = await questView(locals.user.id, new Date(), toTimeZone(cookies.get(TZ_COOKIE)));
	if (!view) error(404, 'Import a deck to open the map.');
	return json(view);
};
