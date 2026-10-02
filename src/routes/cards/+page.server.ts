import { fail } from '@sveltejs/kit';
import { importDeck, listDecks } from '$lib/server/cards/repo';
import { overview } from '$lib/server/cards/stats';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { Actions, PageServerLoad } from './$types';

// Vercel rejects request bodies over 4.5 MB before the function runs. The two
// source decks are 0.4 MB and 0.5 MB.
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export const load: PageServerLoad = async ({ cookies, locals, url }) => {
	const [decks, stats] = await Promise.all([
		listDecks(locals.user!.id),
		overview(locals.user!.id, new Date(), toTimeZone(cookies.get(TZ_COOKIE)))
	]);
	// Set by the deck page's delete action on its way here.
	const deleted = url.searchParams.get('deleted')?.slice(0, 200) || null;
	return { decks, stats, deleted };
};

export const actions: Actions = {
	import: async ({ request, locals }) => {
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose an Anki .txt export.' });
		}
		if (file.size > MAX_IMPORT_BYTES) {
			return fail(413, { message: 'That file is over 4 MB. Export one deck at a time.' });
		}
		try {
			const { imported, warnings } = await importDeck(locals.user!.id, await file.text());
			return { message: `Imported ${imported} cards.`, warnings };
		} catch (e) {
			console.error('[cards] import', e);
			return fail(400, { message: 'Could not read that file as an Anki export.' });
		}
	}
};
