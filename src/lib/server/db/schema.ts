import { sql } from 'drizzle-orm';
import {
	bigserial,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	vector
} from 'drizzle-orm/pg-core';

// TDD §4. Every table carries user_id on the row, denormalized on purpose: the
// Phase 1 RLS policies read it locally, and a join to prove tenancy is both
// slower and a bug waiting to happen.

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	// Login is an allowlisted address plus the shared DEV_PASSWORD.
	email: text('email').notNull().unique(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
});

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

/** One pending emailed code per address. Only the hash is stored. */
export const loginCode = pgTable('login_code', {
	email: text('email').primaryKey(),
	codeHash: text('code_hash').notNull(),
	attempts: integer('attempts').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

/**
 * Per-address budget across codes, over a rolling window. A code's own 5-try
 * limit resets whenever a new code is issued, so without this an attacker who
 * knows an allowed address gets 5 guesses a minute, indefinitely.
 */
export const loginThrottle = pgTable('login_throttle', {
	email: text('email').primaryKey(),
	windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
	sends: integer('sends').notNull().default(0),
	failures: integer('failures').notNull().default(0)
});

/**
 * The shared primitive. One row reads as a flashcard, a harvested document, or a
 * Quest room depending on the surface asking.
 */
export const node = pgTable(
	'nodes',
	{
		// Derived, URL-safe, and owner-scoped so two tenants importing the same shared
		// deck do not collide on this global key. See ingest/identity.ts.
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		// Raw base91. Contains < & / # %, so it never reaches markup or a path.
		ankiGuid: text('anki_guid'),
		kind: text('kind').notNull().default('card'), // card | doc | concept
		notetype: text('notetype').notNull().default('Basic'),
		front: text('front').notNull(),
		back: text('back').notNull().default(''),
		deck: text('deck').notNull(),
		tags: text('tags')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		url: text('url'), // docs only
		extractionTier: text('extraction_tier'), // full | metadata | failed
		summary: text('summary'), // AI
		difficulty: smallint('difficulty'), // AI, 1-5
		embedding: vector('embedding', { dimensions: 1024 }),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
	},
	(t) => [
		// Idempotent re-import: same GUID updates instead of duplicating.
		uniqueIndex('idx_guid').on(t.userId, t.ankiGuid),
		index('idx_node_deck').on(t.userId, t.deck),
		index('idx_node_embed').using('hnsw', t.embedding.op('vector_cosine_ops'))
	]
);

export const edge = pgTable(
	'edges',
	{
		id: bigserial('id', { mode: 'bigint' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		srcId: text('src_id')
			.notNull()
			.references(() => node.id),
		dstId: text('dst_id')
			.notNull()
			.references(() => node.id),
		kind: text('kind').notNull(), // deck | tag | similar_to | prereq_of | cites
		weight: real('weight').notNull().default(1),
		provenance: text('provenance').notNull() // import | ai | manual
	},
	(t) => [
		// Quest traversal.
		index('idx_edge_src').on(t.userId, t.srcId, t.kind),
		uniqueIndex('idx_edge_unique').on(t.userId, t.srcId, t.dstId, t.kind)
	]
);

/**
 * FSRS state. `stability` is the hinge of the product: the scheduler's
 * memory-strength estimate and the Quest door gate are the same column.
 *
 * Optional per node. Harvested documents have no schedule until promoted, because
 * auto-enrolling 3,861 bookmarks would destroy the review queue.
 */
export const reviewState = pgTable(
	'review_state',
	{
		nodeId: text('node_id')
			.primaryKey()
			.references(() => node.id),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		stability: real('stability').notNull().default(0),
		difficulty: real('difficulty').notNull().default(0),
		due: timestamp('due', { withTimezone: true, mode: 'date' }).notNull(),
		reps: integer('reps').notNull().default(0),
		lapses: integer('lapses').notNull().default(0),
		state: smallint('state').notNull().default(0), // 0 new 1 learn 2 review 3 relearn
		// Which (re)learning step the card is on. ts-fsrs needs it to walk the phases.
		learningSteps: integer('learning_steps').notNull().default(0),
		scheduledDays: integer('scheduled_days').notNull().default(0),
		lastReview: timestamp('last_review', { withTimezone: true, mode: 'date' })
	},
	(t) => [
		// The hot path. Partial, because new cards are not due-queried.
		index('idx_review_due')
			.on(t.userId, t.due)
			.where(sql`state != 0`)
	]
);

export const reviewLog = pgTable(
	'review_log',
	{
		id: bigserial('id', { mode: 'bigint' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		nodeId: text('node_id')
			.notNull()
			.references(() => node.id),
		rating: smallint('rating').notNull(), // 1..4
		// FSRS state before this review, 0 new 1 learn 2 review 3 relearn. Separates
		// true retention (reviews of state 2) from learning steps, and is one of the
		// inputs the FSRS optimizer needs when TDD R7 comes due. Null only on rows
		// written before the column existed.
		state: smallint('state'),
		elapsedDays: integer('elapsed_days').notNull().default(0),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' })
			.notNull()
			.defaultNow(),
		// Cards or Quest. One write path, observable per surface, so "does the game
		// improve adherence?" is answerable with data.
		surface: text('surface').notNull(),
		assessmentId: text('assessment_id').references(() => assessment.id),
		// 0 for a card's first try in a round, n for its nth relearning repeat. Unique
		// per round so a retried request cannot log the same attempt twice.
		attempt: smallint('attempt').notNull().default(0)
	},
	(t) => [
		index('idx_log_node').on(t.userId, t.nodeId),
		uniqueIndex('idx_log_attempt').on(t.assessmentId, t.nodeId, t.attempt)
	]
);

/**
 * The grading artifact: one row per study round over one deck. The next round
 * for that deck reads `weak` and `strong` to decide which cards to include.
 */
export const assessment = pgTable(
	'assessments',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		deck: text('deck').notNull(),
		startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
		cardCount: integer('card_count').notNull().default(0),
		// The round's cards in serving order. Lets a reload resume the round instead of
		// opening a new one, and lets a grade prove its card belongs to the round.
		cardIds: text('card_ids')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		score: real('score'), // 0..1, first attempts only
		areas: jsonb('areas'), // AreaScore[], one per tag measured in this round
		// Standing[]: per-tag evidence carried across rounds. `strong` and `weak` are
		// read from it, not from this round's areas alone. See grading.ts.
		standing: jsonb('standing'),
		strong: text('strong')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		weak: text('weak')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`)
	},
	(t) => [index('idx_assessment_deck').on(t.userId, t.deck, t.finishedAt)]
);

/**
 * A harvest attempt, kept separate from the graph. Most harvests are not nodes:
 * 3,861 URLs produce failures, duplicates and low-confidence proposals, and a
 * failed fetch should be a row you can retry rather than a missing node.
 */
export const harvest = pgTable(
	'harvests',
	{
		id: bigserial('id', { mode: 'bigint' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		urlNormalized: text('url_normalized').notNull(), // utm stripped, no fragment
		contentHash: text('content_hash'), // cross-domain duplicate detection
		status: text('status').notNull().default('queued'),
		tier: text('tier'), // full | metadata | failed
		confidence: real('confidence'),
		proposal: jsonb('proposal'),
		nodeId: text('node_id').references(() => node.id),
		failReason: text('fail_reason'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('idx_url').on(t.userId, t.urlNormalized),
		// The review page lists one status at a time, oldest first.
		index('idx_harvest_status').on(t.userId, t.status, t.id),
		// Cross-domain duplicates: the same story on apple.news and the publisher.
		index('idx_harvest_hash').on(t.userId, t.contentHash)
	]
);

export const questRun = pgTable('quest_runs', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	currentNodeId: text('current_node_id').references(() => node.id),
	visited: text('visited')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	state: jsonb('state')
});

/** Queue on Postgres. Claimed with FOR UPDATE SKIP LOCKED by the cron worker. */
export const job = pgTable(
	'jobs',
	{
		id: bigserial('id', { mode: 'bigint' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id),
		kind: text('kind').notNull(), // extract | triage | embed | link
		status: text('status').notNull().default('queued'),
		payload: jsonb('payload'),
		attempts: integer('attempts').notNull().default(0),
		claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
	},
	(t) => [index('idx_job_claim').on(t.status, t.kind)]
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Node = typeof node.$inferSelect;
export type Edge = typeof edge.$inferSelect;
export type ReviewState = typeof reviewState.$inferSelect;
export type ReviewLog = typeof reviewLog.$inferSelect;
export type Assessment = typeof assessment.$inferSelect;
export type Harvest = typeof harvest.$inferSelect;
export type QuestRun = typeof questRun.$inferSelect;
export type Job = typeof job.$inferSelect;
