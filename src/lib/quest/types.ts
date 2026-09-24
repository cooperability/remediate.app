// The Quest view model: what the server sends and the /quest screen draws.
// Plain data, no server imports, so both sides share it.

/**
 * What a node is to the player. Cards are rooms you earn; decks and tags are the
 * halls between them. `concept` is any other concept node, such as the ones
 * enrichment (Phase 5) will write.
 */
export type Facet = 'card' | 'deck' | 'tag' | 'concept';

/**
 * open: walk through. locked: a recall encounter is waiting behind it.
 * sealed: locked, and no encounter is possible yet (see SealReason).
 */
export type DoorStatus = 'open' | 'locked' | 'sealed';

/**
 * new-cap: a card you have never seen, and today's new-card allowance for its
 * deck is spent (shared with Cards). cooling: you missed it; it opens for another
 * try when FSRS says it is due. prereq: something it builds on (a prereq_of edge
 * into it) is not known yet.
 */
export type SealReason = 'new-cap' | 'cooling' | 'prereq';

export interface Gate {
	status: DoorStatus;
	reason?: SealReason;
	/** ISO time the seal lifts, for cooling doors. */
	retryAt?: string;
	/** An open card FSRS says is due: a review is on offer to keep the door open. */
	due?: boolean;
	/** For prereq seals: what to learn first. */
	needs?: string[];
}

export interface Door extends Gate {
	to: string;
	facet: Facet;
	title: string;
	/** The edge kind this door follows: deck, tag, and later similar_to or prereq_of. */
	via: string;
	/** The edge points from this room to the door's room (a prereq_of: "leads to"), or back ("builds on"). */
	out: boolean;
	/** Never reviewed. A locked new door is a first meeting, not a rematch. */
	fresh: boolean;
}

export interface Room {
	id: string;
	facet: Facet;
	title: string;
	/** Sanitized card HTML (ingest/sanitize.ts). Cards only. */
	front?: string;
	back?: string;
	tags?: string[];
	deck?: string;
	/** Recall probability now, 0..1. Cards you have reviewed only. */
	strength?: number | null;
	/** For a deck or tag: how many of its cards you know, of how many. */
	progress?: { known: number; total: number };
	doors: Door[];
}

export interface MapNode {
	id: string;
	facet: Facet;
	title: string;
	x: number;
	y: number;
	/** Passable now. False only for a visited card that has since lapsed. */
	open: boolean;
	visited: boolean;
	/** Cards: recall probability now. Concepts: share of their cards known. */
	strength: number | null;
	/** Concepts: their card count, for sizing. */
	weight?: number;
	/**
	 * A door from the current room into a card you do not know yet: shown faintly
	 * so the room's reach is visible, while the rest of the unknown stays in fog.
	 */
	ghost?: boolean;
}

export interface MapView {
	nodes: MapNode[];
	/** Index pairs into `nodes`. */
	edges: [number, number][];
	current: string;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	stats: {
		cardsKnown: number;
		cardsTotal: number;
		conceptsFound: number;
		conceptsTotal: number;
		visited: number;
	};
}

export interface EncounterCard {
	encounterId: string;
	nodeId: string;
	front: string;
	back: string;
	tags: string[];
	fresh: boolean;
	/** A review of a card you know: recall it to keep its door open. */
	review: boolean;
}

/**
 * What "Next encounter" will open. review: a known card that is due, so the door
 * stays open. rematch: a missed card that is due again. new: a first meeting,
 * picked next to what you already know.
 */
export interface Suggestion {
	to: string;
	title: string;
	kind: 'review' | 'rematch' | 'new';
	/** How many encounters are on offer across the map right now. */
	waiting: number;
}

export interface QuestView {
	room: Room;
	map: MapView;
	/** Left over from an interrupted encounter: resume it rather than lose it. */
	encounter: EncounterCard | null;
	next: Suggestion | null;
}

/** The recall bar every door opens at. PRD Q2: one successful recall; tune after playtest. */
export const DOOR_THRESHOLD = 1.0;

export const VIA_LABEL: Record<string, string> = {
	deck: 'in deck',
	tag: 'tagged',
	similar_to: 'related',
	prereq_of: 'leads to',
	'prereq_of:in': 'builds on',
	cites: 'cites'
};

/** What POST /api/review/grade answers for an encounter. */
export interface Outcome {
	rating: number;
	/** The door is open after this grade, and the player stepped through it. */
	unlocked: boolean;
	/** It was a review of a known card, not a first opening. */
	review?: boolean;
	/** When a door that stayed shut can be tried again. */
	retryAt?: string;
	/** Decks and tags this recall took to mastery (CLEAR_SHARE of their cards known). */
	cleared?: string[];
}

/** Share of a deck's or tag's cards known for it to count as cleared. */
export const CLEAR_SHARE = 0.8;
