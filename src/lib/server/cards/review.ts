import type { Grade } from 'ts-fsrs';
import type { db } from '$lib/server/db';
import * as table from '$lib/server/db/schema';
import { grade } from './scheduler';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ReviewWrite {
	userId: string;
	nodeId: string;
	/** The card's state as read under the caller's row lock. Null for a card never reviewed. */
	review: table.ReviewState | null;
	rating: Grade;
	now: Date;
	surface: 'cards' | 'quest';
	assessmentId?: string;
	attempt?: number;
	encounterId?: string;
}

/**
 * The one review write path (PRD QST-3). Cards rounds and Quest encounters both
 * land here: one FSRS step, one review_log row tagged with the surface, one
 * review_state upsert. The caller owns the transaction and must hold the card's
 * row lock, so two writers cannot both step from the same prior state.
 */
export async function writeReview(tx: Tx, r: ReviewWrite) {
	const { next, elapsedDays, priorState } = grade(r.review, r.rating, r.now);
	await tx.insert(table.reviewLog).values({
		userId: r.userId,
		nodeId: r.nodeId,
		rating: r.rating,
		state: priorState,
		elapsedDays,
		reviewedAt: r.now,
		surface: r.surface,
		assessmentId: r.assessmentId ?? null,
		attempt: r.attempt ?? 0,
		encounterId: r.encounterId ?? null
	});
	await tx
		.insert(table.reviewState)
		.values({ nodeId: r.nodeId, userId: r.userId, ...next })
		.onConflictDoUpdate({ target: table.reviewState.nodeId, set: next });
	return next;
}
