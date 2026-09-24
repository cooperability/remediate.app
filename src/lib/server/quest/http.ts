import { json } from '@sveltejs/kit';
import type { MoveCheck } from './engine';

const MESSAGES: Record<MoveCheck | 'empty', [number, string]> = {
	ok: [200, ''],
	here: [200, ''],
	empty: [404, 'Import a deck to open the map.'],
	'unknown-node': [404, 'No such place.'],
	unreachable: [409, 'No door leads there from here.'],
	locked: [409, 'That door is locked. Recall the card to open it.'],
	sealed: [409, 'That door is sealed for now.']
};

/** A refused move or encounter, as a status the client can show. */
export function refusal(reason: MoveCheck | 'empty') {
	const [status, message] = MESSAGES[reason];
	return json({ reason, message }, { status });
}

/** The `to` field of a request body, or null. */
export async function targetOf(request: Request): Promise<string | null> {
	const body = await request.json().catch(() => null);
	const to = body?.to;
	return typeof to === 'string' && to.length > 0 && to.length <= 64 ? to : null;
}
