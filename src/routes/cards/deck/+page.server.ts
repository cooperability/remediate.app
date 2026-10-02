import { error, fail, redirect } from '@sveltejs/kit';
import { deleteDeck } from '$lib/server/cards/repo';
import { browseCards, parseBrowseParams } from '$lib/server/cards/browse';
import { deckDetail } from '$lib/server/cards/stats';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { Actions, PageServerLoad } from './$types';

// Deck names contain '/', so the deck rides in the query string, not the path.
export const load: PageServerLoad = async ({ url, cookies, locals }) => {
	const deck = url.searchParams.get('deck');
	if (!deck) error(400, 'Pick a deck.');
	const userId = locals.user!.id;
	const [detail, browse] = await Promise.all([
		deckDetail(userId, deck, new Date(), toTimeZone(cookies.get(TZ_COOKIE))),
		browseCards(userId, deck, parseBrowseParams(url.searchParams))
	]);
	if (!detail) error(404, 'No cards in that deck.');
	return { deck, ...detail, browse };
};

export const actions: Actions = {
	delete: async ({ request, locals }) => {
		const form = await request.formData();
		const deck = String(form.get('deck') ?? '');
		if (!deck) return fail(400, { message: 'Pick a deck.' });
		if (form.get('confirm') !== 'yes') {
			return fail(400, { message: 'Tick the box to confirm.' });
		}
		await deleteDeck(locals.user!.id, deck);
		// The dashboard says what went, so the deck's absence reads as done, not lost.
		redirect(303, `/cards?deleted=${encodeURIComponent(deck)}`);
	}
};
