import { error, json } from '@sveltejs/kit';
import type { Grade } from 'ts-fsrs';
import { MAX_REPEATS } from '$lib/cards/round';
import { cardPreview, recordGrade } from '$lib/server/cards/repo';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401);
	// A malformed body is the client's error, not a 500.
	const { assessmentId, nodeId, rating, attempt } = await request.json().catch(() => ({}));
	if (
		![1, 2, 3, 4].includes(rating) ||
		!(Number.isInteger(attempt) && attempt >= 0 && attempt <= MAX_REPEATS) ||
		typeof assessmentId !== 'string' ||
		typeof nodeId !== 'string'
	) {
		error(400, 'Bad grade.');
	}
	const stored = await recordGrade(locals.user.id, assessmentId, nodeId, rating as Grade, attempt);
	if (stored === null) error(404);
	// A retried attempt keeps its first rating. The client re-queues on this one, and
	// a missed card comes back with labels from its new state.
	const preview = stored === 1 ? await cardPreview(locals.user.id, nodeId) : null;
	return json({ rating: stored, preview });
};
