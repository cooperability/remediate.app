import { fail } from '@sveltejs/kit';
import { extractUrls } from '$lib/server/bmx/normalize-url';
import {
	acceptHarvests,
	deckNames,
	importArticlesCsv,
	listHarvests,
	processQueue,
	queueUrls,
	setStatus,
	STATUSES,
	type Status
} from '$lib/server/bmx/queue';
import type { Actions, PageServerLoad } from './$types';

// Same cap as the deck import: Vercel refuses bodies over 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PASTE = 500;

const toStatus = (v: string | null): Status =>
	STATUSES.includes(v as Status) ? (v as Status) : 'ready';

export const load: PageServerLoad = async ({ url, locals }) => {
	const userId = locals.user!.id;
	const status = toStatus(url.searchParams.get('status'));
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
	const [list, decks] = await Promise.all([listHarvests(userId, status, page), deckNames(userId)]);
	return { status, decks, ...list };
};

const ids = (form: FormData) => form.getAll('id').map(String);

export const actions: Actions = {
	queue: async ({ request, locals }) => {
		const text = String((await request.formData()).get('urls') ?? '');
		const urls = extractUrls(text);
		if (!urls.length) return fail(400, { message: 'No http or https links found.' });
		if (urls.length > MAX_PASTE) {
			return fail(400, { message: `${urls.length} links. Paste up to ${MAX_PASTE} at a time.` });
		}
		const { queued, already } = await queueUrls(locals.user!.id, urls);
		return {
			message: `Queued ${queued} link${queued === 1 ? '' : 's'}.${already ? ` ${already} already harvested.` : ''}`,
			autoFetch: queued > 0
		};
	},

	fetch: async ({ locals }) => {
		const { done, remaining } = await processQueue(locals.user!.id);
		return { message: `Fetched ${done}. ${remaining} left in the queue.`, remaining };
	},

	csv: async ({ request, locals }) => {
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a CSV with a url column.' });
		}
		if (file.size > MAX_BYTES) return fail(413, { message: 'That file is over 4 MB.' });
		try {
			const r = await importArticlesCsv(locals.user!.id, await file.text());
			return {
				message: `Added ${r.added} of ${r.rows} rows. ${r.already} already harvested, ${r.duplicates} duplicates, ${r.skipped} without a usable URL.`
			};
		} catch (e) {
			console.error('[harvest] csv', e);
			return fail(400, { message: 'Could not read that file as a CSV with a url column.' });
		}
	},

	accept: async ({ request, locals }) => {
		const form = await request.formData();
		const deck = String(form.get('newDeck') ?? '').trim() || String(form.get('deck') ?? '').trim();
		if (!deck) return fail(400, { message: 'Pick a deck or name a new one.' });
		if (deck.length > 200) return fail(400, { message: 'That deck name is too long.' });
		const tags = [
			...new Set(
				String(form.get('tags') ?? '')
					.split(/[\s,]+/)
					.map((t) => t.trim())
					.filter(Boolean)
			)
		].slice(0, 20);
		const n = await acceptHarvests(locals.user!.id, ids(form), deck, tags);
		if (!n) return fail(400, { message: 'Select at least one link.' });
		return { message: `Added ${n} card${n === 1 ? '' : 's'} to ${deck}.` };
	},

	discard: async ({ request, locals }) => {
		const n = await setStatus(locals.user!.id, ids(await request.formData()), 'discarded', [
			'ready',
			'duplicate',
			'failed'
		]);
		return { message: `Discarded ${n}.` };
	},

	retry: async ({ request, locals }) => {
		const n = await setStatus(locals.user!.id, ids(await request.formData()), 'queued', [
			'failed',
			'discarded'
		]);
		return { message: `Re-queued ${n}.`, autoFetch: n > 0 };
	}
};
