import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase64url } from '@oslojs/encoding';

function digest(input: string): string {
	return encodeBase64url(sha256(new TextEncoder().encode(input))).slice(0, 16);
}

/**
 * URL-safe node id derived from an Anki GUID, scoped to the owner.
 *
 * The owner is in the digest because `nodes.id` is a global primary key, and Anki
 * GUIDs are stable across exports and propagate through shared decks. Digesting
 * the GUID alone would make the second importer of a shared deck collide with the
 * first on every overlapping card. Never put the raw GUID in markup or a path.
 */
export function internalId(userId: string, guid: string): string {
	return digest(`${userId}\u0000${guid}`);
}

/**
 * Identity for exports with no `#guid column:` preamble, such as the legacy CSV.
 * Weaker than a GUID: editing a card changes the hash, so re-import creates a new
 * node instead of updating one. Owner-scoped for the same reason as internalId.
 */
export function contentId(userId: string, deck: string, front: string, back: string): string {
	return digest(`${userId}\u0000${deck}\u0000${front}\u0000${back}`);
}

/**
 * Id for a concept node: a deck hub or a tag. Quest derives these from the cards'
 * own deck and tags columns (quest/graph.ts), so the same name always lands on the
 * same node. Owner-scoped for the same reason as internalId.
 */
export function conceptId(userId: string, facet: 'deck' | 'tag', name: string): string {
	// A separator no other digest input uses, and the facet first: with the same
	// \u0000 layout as contentId, a card in deck "concept" with front "tag" would
	// hash to the same id as a tag.
	return digest(`concept\u0001${facet}\u0001${userId}\u0001${name}`);
}
