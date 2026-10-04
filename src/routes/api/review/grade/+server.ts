import { error, json } from '@sveltejs/kit';
import type { Grade } from 'ts-fsrs';
import { MAX_REPEATS } from '$lib/cards/round';
import { cardPreview, recordGrade } from '$lib/server/cards/repo';
import { refusal } from '$lib/server/quest/http';
import { gradeEncounter } from '$lib/server/quest/repo';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { RequestHandler } from './$types';

// Ids are short: 16-character node ids, 36-character UUIDs, server-made round ids.
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

// The one review endpoint (PRD QST-3). A Cards round sends { assessmentId,
// attempt }; a Quest encounter sends { encounterId }. Both reach writeReview.
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) error(401);
	// A malformed body is the client's error, not a 500.
	const body = await request.json().catch(() => ({}));
	const { assessmentId, encounterId, nodeId, rating, attempt } = body ?? {};
	if (![1, 2, 3, 4].includes(rating) || !isId(nodeId)) error(400, 'Bad grade.');

	if (encounterId !== undefined) {
		if (!isId(encounterId) || assessmentId !== undefined) error(400, 'Bad grade.');
		const graded = await gradeEncounter(
			locals.user.id,
			encounterId,
			nodeId,
			rating as Grade,
			new Date(),
			toTimeZone(cookies.get(TZ_COOKIE))
		);
		if (graded === null) error(404);
		// The door changed under the encounter (graded in Cards, allowance spent, a new day).
		if ('refused' in graded) return refusal(graded.refused);
		return json(graded);
	}

	if (
		!(Number.isInteger(attempt) && attempt >= 0 && attempt <= MAX_REPEATS) ||
		!isId(assessmentId)
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
