import { error, json } from '@sveltejs/kit';
import type { Grade } from 'ts-fsrs';
import { MAX_REPEATS } from '$lib/cards/round';
import { cardPreview, recordGrade } from '$lib/server/cards/repo';
import { gradeEncounter } from '$lib/server/quest/repo';
import type { RequestHandler } from './$types';

// The one review endpoint (PRD QST-3). A Cards round sends { assessmentId,
// attempt }; a Quest encounter sends { encounterId }. Both reach writeReview.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401);
	// A malformed body is the client's error, not a 500.
	const body = await request.json().catch(() => ({}));
	const { assessmentId, encounterId, nodeId, rating, attempt } = body ?? {};
	if (![1, 2, 3, 4].includes(rating) || typeof nodeId !== 'string') error(400, 'Bad grade.');

	if (encounterId !== undefined) {
		if (typeof encounterId !== 'string' || assessmentId !== undefined) error(400, 'Bad grade.');
		const graded = await gradeEncounter(locals.user.id, encounterId, nodeId, rating as Grade);
		if (graded === null) error(404);
		return json(graded);
	}

	if (
		!(Number.isInteger(attempt) && attempt >= 0 && attempt <= MAX_REPEATS) ||
		typeof assessmentId !== 'string'
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
