import { questView, syncImportGraph } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const userId = locals.user!.id;
	// Cheap when nothing changed. Catches cards written by anything but importDeck (the seed script).
	await syncImportGraph(userId);
	return { view: await questView(userId, new Date(), toTimeZone(cookies.get(TZ_COOKIE))) };
};
