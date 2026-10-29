# Roadmap

The ranked backlog for Remediate: every open bug and every remaining epic, in one priority order, each written as a task card an agent can pick up cold. It replaces the build plan in [PIPELINE.md](./PIPELINE.md), whose phases are now history.

**State:** verified against `main` at `466384c` on 2026-10-11. Cards, Quest's core loop and BMX harvest are live. AI enrichment, BMX triage and the Quest playtest are not started.

**Sources:** one adversarial design review of PRD, TDD, PIPELINE and README against the tree, and three adversarial code reviews (auth/tenancy/ingest/Cards, BMX harvest, Quest/PWA). Each finding below was re-read against the code before it landed here. Findings that touch the database were traced, not executed, because those tests need Postgres. They are labelled Probable until a database test runs them.

## How to use this file

1. Take the highest-ranked card whose **Status** is `open` and whose **Depends** are done. Cards marked Human need Cooper. An agent skips them.
2. Read the card's **Where** files before anything else. Line numbers are as of the commit that last edited this file. Search for the quoted code if they have moved.
3. Write the **Acceptance** tests first and watch them fail. Then fix. Then revert the fix once and confirm the test goes red again.
4. In the same PR, move the card to [Done](#done) with the PR link. Edit the card in place if the scope changed. Do not append a correction below it.

### Ranking rule

Risk first, then value.

1. Security holes and silent data corruption, by blast radius.
2. Cooper's priority epics (set 2026-10-11): observability, the card editor and AI features, with the human steps they wait on.
3. Other epics and gates, by daily-use value per unit of work and by what they unblock.
4. Minor bugs, cleanup and test gaps.

Size is scope, not time: **S** touches one module and its test, **M** touches a few modules or adds a migration, **L** needs a design note first.

### Working in this repo

| Fact                  | Detail                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                  | 22. `isomorphic-dompurify` is pinned to 2.26.0. Later versions pull jsdom 27+, which Vercel's runtime cannot load ([#345](https://github.com/cooperability/remediate.app/pull/345)). Dependabot ignores newer versions. |
| Typecheck             | `yarn run check`. Plain `yarn check` runs Yarn 1's built-in integrity check, not svelte-check.                                                                                                                          |
| Unit tests            | `yarn test:server`. Without `DATABASE_URL`, the `*.db.test.ts` files skip. 337 pass and 72 skip that way on this branch.                                                                                                |
| Database tests        | `yarn db:up` (Docker), `yarn db:migrate`, then `yarn test:server` with `DATABASE_URL` set. CI runs them against pgvector/pg17 on every PR.                                                                              |
| e2e                   | `yarn test:e2e`. On Windows, `adapter-vercel` fails to create a symlink (EPERM) during the build, so e2e runs in CI.                                                                                                    |
| Request model         | Every signed-in request runs inside one `asTenant` transaction (`src/hooks.server.ts:63`, `src/lib/server/db/index.ts:86`). A thrown error rolls back everything that request wrote.                                    |
| One review write path | `writeReview` in `src/lib/server/cards/review.ts` is the only code that steps FSRS. Cards and Quest both call it. Keep it that way (PRD QST-3).                                                                         |
| Lock order            | Per-user advisory lock (`questLock`), then the run row, then a card row. Documented at `src/lib/server/quest/repo.ts:40-49`.                                                                                            |

## Ranked backlog

|   # | ID                                                             | Task                                                             | Type          | Size | Status |
| --: | -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | :--: | ------ |
|   1 | [DATA-A](#data-a-read-review-state-after-taking-the-card-lock) | Read review state after taking the card lock                     | bug, data     |  S   | open   |
|   2 | [DATA-B](#data-b-make-finishround-idempotent)                  | Make `finishRound` idempotent                                    | bug, data     |  S   | open   |
|   3 | [DATA-C](#data-c-isolate-each-harvest-row)                     | Isolate each harvest row so one page cannot wedge the queue      | bug, data     |  M   | open   |
|   4 | [SEC-B](#sec-b-narrow-the-tenant-roles-grants)                 | Narrow the tenant role's grants, and test RLS coverage           | bug, security |  S   | open   |
|   5 | [DATA-D](#data-d-take-the-quest-lock-in-deletedeck)            | Take the Quest lock in `deleteDeck`                              | bug, data     |  S   | open   |
|   6 | [QST-C](#qst-c-hide-the-answer-before-a-quest-review)          | Hide the answer before a Quest review of the room's own card     | bug, data     |  S   | open   |
|   7 | [OPS-1](#ops-1--human-deploy-and-credential-checks)            | Deploy and credential checks                                     | human         |  S   | open   |
|   8 | [OBS-A](#obs-a-observability)                                  | Observability: request logs, timings, error ids, a latency check | epic          |  M   | open   |
|   9 | [CRD-A](#crd-a-card-editor-for-phone-and-desktop)              | Card editor for phone and desktop                                | epic          |  L   | open   |
|  10 | [BMX-A](#bmx-a--human-decide-what-a-bookmark-becomes)          | Decide what a bookmark becomes in the graph                      | human         |  S   | open   |
|  11 | [AI-A](#ai-a-enrichment-lite)                                  | Enrichment-lite: summaries, concepts, concept-overlap edges      | epic          |  L   | open   |
|  12 | [AI-B](#ai-b--human-read-20-ai-edges)                          | Read 20 AI edges (gate B3)                                       | human         |  S   | open   |
|  13 | [BMX-B](#bmx-b-keep-the-article-text)                          | Keep the harvested article text                                  | epic          |  M   | open   |
|  14 | [BMX-C](#bmx-c-triage-as-a-suggestion)                         | BMX triage as a pre-filled suggestion                            | epic          |  M   | open   |
|  15 | [AI-D](#ai-d-suggest-cards-from-a-harvested-article)           | Suggest cards from a harvested article                           | epic          |  M   | open   |
|  16 | [AI-C](#ai-c-design-prereq_of)                                 | Design how `prereq_of` edges are produced                        | epic          |  L   | open   |
|  17 | [QST-A](#qst-a--human-playtest-quest-on-a-phone)               | Playtest Quest on a phone (gate B4)                              | human         |  S   | open   |
|  18 | [QST-B](#qst-b-quest-onboarding)                               | Quest onboarding: a first player can tell how it works           | epic          |  M   | open   |
|  19 | [CRD-C](#crd-c-undo-the-last-grade)                            | Undo the last grade                                              | epic          |  M   | open   |
|  20 | [QST-D](#qst-d-make-quest-scale-with-tag-count)                | Make Quest's map layout scale with tag count                     | bug, perf     |  M   | open   |
|  21 | [SEC-C](#sec-c-security-headers-and-a-graded-deploy)           | Security headers and a graded deploy                             | epic          |  S   | open   |
|  22 | [P1-A](#p1-a-media-apkg-and-export)                            | Media, `.apkg` import, export to Anki                            | epic          |  L   | open   |
|  23 | [BMX-D](#bmx-d-harvest-politeness-and-parsing-fixes)           | Harvest politeness and parsing fixes                             | bugs          |  M   | open   |
|  24 | [PWA-A](#pwa-a-offline-and-installed-app-follow-ups)           | Offline and installed-app follow-ups                             | bugs          |  M   | open   |
|  25 | [QST-E](#qst-e-quest-polish)                                   | Quest polish: stale tabs, learning cards                         | bugs          |  S   | open   |
|  26 | [CRD-B](#crd-b-cards-and-auth-minor-fixes)                     | Cards and auth minor fixes                                       | bugs          |  S   | open   |
|  27 | [TEST-A](#test-a-tests-that-cannot-fail-today)                 | Tests for behaviour no test pins today                           | tests         |  M   | open   |
|  28 | [CLEAN-A](#clean-a-remove-orphaned-schema-and-config)          | Remove orphaned schema and config                                | cleanup       |  S   | open   |

[Deferred and cut](#deferred-and-cut) lists what was decided against, so nobody builds it from an old doc.

---

## 1. Security and data integrity

### DATA-A: Read review state after taking the card lock

- **Type** bug, silent data corruption · **Size** S · **Depends** none · **Evidence** Probable: traced to lines and documented Postgres READ COMMITTED behaviour, not executed.
- **Why.** `recordGrade` and `gradeEncounter` read `review_state` in the same statement that locks the card (`select … left join review_state … for update of nodes`). When a second grade waits on that lock, Postgres hands it the `review_state` row from its pre-wait snapshot, because the first writer never updated the locked `nodes` row. The second grade steps FSRS from the stale state and overwrites the first grade's result. Quest's "already graded in Cards" refusal also judges on the stale state, so it grades instead of refusing. Nothing errors.
- **Where.** `src/lib/server/cards/repo.ts:324-331` and `:346`, `src/lib/server/quest/repo.ts:551-561` and `:576`, contract at `src/lib/server/cards/review.ts:11,25`.
- **Do.** In both paths, lock first (`select id from nodes … for update`), then read `review_state` in a separate statement in the same transaction. A new statement takes a fresh snapshot.
- **Acceptance.** A DB test that grades one card from Cards and from Quest at once (`Promise.all`, each in its own `asTenant`). It asserts two `review_log` rows, the second row's prior state equals the first write's result, and final `reps === 2`. On `main` it gives `reps === 1`. Force the interleaving (hold the card lock in an outer transaction while the second grade starts, then commit), or the test can pass on `main` by timing luck.

### DATA-B: Make `finishRound` idempotent

- **Type** bug, silent data corruption · **Size** S · **Depends** none · **Evidence** Probable: traced, not executed.
- **Why.** `finishRound` has no lock and no `finished_at is null` guard on its update. Two tabs finishing the same round can both merge its evidence into `standing`, which inflates every tag's weight. A tag then turns "strong" a round early and drops out of review. If the first finish commits before the second reads, the second tab gets a 404 on every retry.
- **Where.** `src/lib/server/cards/repo.ts:298-304` (`ownedOpenAssessment`), `:365-397` (`finishRound`), `src/routes/api/review/finish/+server.ts`. `startRound` also calls it through `closeStaleRound` (`repo.ts:227,291`).
- **Do.** Lock the assessment row (`for update`), re-check `finished_at` under the lock, add `and finished_at is null` to the update. When it is already finished, return the stored grades so a retry gets 200.
- **Acceptance.** DB tests: a sequential second `finishRound` returns the same grades and leaves `standing` byte-equal. Two concurrent calls store `mergeStanding(prior, areas)` exactly once. Both fail on `main`.

### DATA-C: Isolate each harvest row

- **Type** bug, data · **Size** M · **Depends** none · **Evidence** Confirmed structure. The wedge itself is Probable (needs Postgres to run).
- **Why.** `processQueue` claims up to 10 rows `for update skip locked`, then fetches and writes each one inside the request's single `asTenant` transaction. If any write throws, the whole round rolls back, the bad row stays the oldest `queued` row, and every later round dies on it again. A queued row cannot be discarded, so the user has no way out. [#356](https://github.com/cooperability/remediate.app/pull/356) removed one trigger (a lone UTF-16 surrogate reaching jsonb). Others remain: any DB error, or the function hitting its duration limit (worst case about 23 s per round: 8 s budget plus 5 s robots plus 10 s page). No `maxDuration` is set.
- **Where.** `src/lib/server/bmx/queue.ts:166-209`, `src/routes/harvest/+page.server.ts:89-93` (discard accepts only ready, duplicate, failed), `src/routes/harvest/+page.svelte:173,222`, `src/hooks.server.ts:63`.
- **Do.** Per row: claim, commit, fetch outside any transaction, write the result in its own short transaction. A row whose write throws becomes `failed` with the reason. Let a `queued` row be discarded. Write this "claim, commit, call, commit" shape into TDD §6 as the pattern AI-A will reuse.
- **Don't.** Hold a database transaction open across a network call.
- **Acceptance.** A DB test where the second of three rows' writes throws: rows 1 and 3 are `ready`, row 2 is `failed`, the call returns. Discarding a `queued` row works. Both fail on `main`.

### SEC-B: Narrow the tenant role's grants

- **Type** bug, security (defence in depth) · **Size** S · **Depends** none · **Evidence** Confirmed by reading the migration.
- **Why.** Migration `0003_rls` grants `remediate_app` full DML on every table, `user` and `session` included, and on every future table through default privileges. Only the eight tables with `user_id` get policies. Inside `asTenant`, any query can read every user's email or delete every session. A future table with `user_id` and no policy is cross-tenant from its first migration, and no test catches it. There is no injection sink today, so this is a second wall with a gap, not an open hole.
- **Where.** `drizzle/0003_rls.sql:16-52`, `src/lib/server/db/rls.db.test.ts`, logout at `src/routes/login/+page.server.ts:34-38`.
- **Do.** A new migration revokes `remediate_app` on `user`, `session`, `login_code`, `login_throttle`. Session lookup already runs before `asTenant` in `hooks.server.ts`. Logout runs inside it, so give logout's `invalidateSession` a path on the root connection (`root` in `db/index.ts` is not exported today). Add a catalog test: every public table with a `user_id` column has `relrowsecurity` and a policy.
- **Acceptance.** The catalog test fails if a policy is dropped. A test that runs `select email from "user"` under `asTenant` is refused.

### DATA-D: Take the Quest lock in `deleteDeck`

- **Type** bug · **Size** S · **Depends** none · **Evidence** Probable: traced, not executed. Two reviewers found it independently.
- **Why.** Every Quest writer takes the per-user advisory lock first. `deleteDeck` does not, and it locks `review_state` before `nodes`, the reverse of a grade. A deck deletion racing a Quest grade on one of its cards deadlocks (40P01), and one request returns 500. No corruption.
- **Where.** `src/lib/server/cards/repo.ts:64-111`, contract at `src/lib/server/quest/repo.ts:44-49`.
- **Do.** `await tx.execute(questLock(userId))` as the first statement of `deleteDeck`, as `importDeck` does.
- **Acceptance.** A DB test modelled on the import-versus-grade test near `quest.db.test.ts:494`: `deleteDeck` and `gradeEncounter` on the same card, 20 iterations through `Promise.allSettled`, expect no rejection.

### QST-C: Hide the answer before a Quest review

- **Type** bug, data quality · **Size** S · **Depends** none · **Evidence** Confirmed by reading the code.
- **Why.** After a player unlocks card K, the server moves them into K's room, and position persists. When K later comes due, `/quest` opens in K's room with front and back visible, and offers a review of K. The player rates a card whose answer they just read, which feeds FSRS false recall.
- **Where.** `src/lib/components/quest/RoomPanel.svelte:18,113-134`, `src/lib/server/quest/engine.ts:337-342`, `src/lib/server/quest/repo.ts:349-351`.
- **Do.** Omit `back` from the room view on the server when the room's own card is due or locked.
- **Acceptance.** A DB test: after K becomes due, `questView` returns no `back` for K's room. Fails on `main`.

---

## 2. Priority epics: observability, the card editor, AI

Cooper ranked these high on 2026-10-11. The human steps they wait on are ranked with them.

### OPS-1 · Human: Deploy and credential checks

Only Cooper can do these. Each is a dashboard or a secret.

| Check                                                           | Status        | Basis                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Root Directory is `.`                                    | Probable done | Vercel preview deployments pass on open PRs (for example [#347](https://github.com/cooperability/remediate.app/pull/347)), and #345 reports runtime errors on production, which needs a successful build. The dashboard value is not in git. |
| Neon `DATABASE_URL` in Vercel                                   | Probable done | [#345](https://github.com/cooperability/remediate.app/pull/345) reports production got a database on 2026-10-09.                                                                                                                             |
| `DEV_PASSWORD` set and `GMAIL_*` removed                        | Unverified    | Deferred deploy step in [#330](https://github.com/cooperability/remediate.app/pull/330).                                                                                                                                                     |
| `remediate.app` and `www.remediate.app` attached to the project | Unverified    | The code assumes `www.remediate.app` (`src/lib/server/bmx/ssrf.ts:100`).                                                                                                                                                                     |
| `ANTHROPIC_API_KEY` in Vercel                                   | Unverified    | Needed by the AI cards (AI-A, BMX-C, AI-D).                                                                                                                                                                                                  |
| Vercel plan and Fluid compute                                   | Unverified    | Decides the default function duration that DATA-C has to fit inside.                                                                                                                                                                         |

**Acceptance.** Cooper ticks each row here, or edits it with the real value.

### OBS-A: Observability

- **Type** epic · **Size** M · **Depends** none to start. Step 6 needs a decision from Cooper.
- **Why.** Nobody would notice most of the failures in this file. The app's only signals are 5 `console` calls in `src` (grep, 2026-10-11) and Vercel's runtime log. The PRD's latency targets (grade to next under 100 ms p95, Quest room under 200 ms, PRD §9) have never been measured in production. A harvest round that hits the function limit rolls back and leaves no record (DATA-C). A stale FSRS write (DATA-A) has no counter. AI-A will spend money on every call, and nothing will show the spend.
- **Where.** `src/hooks.server.ts` (every request passes through `handle`, and there is no `handleError` yet), `src/routes/api/review/grade/+server.ts`, `src/routes/api/quest/*`, `src/lib/server/bmx/queue.ts`, `src/routes/cards/+page.server.ts` (import), `src/lib/server/health.ts`.
- **Do.**
  1. A small logger module, no dependency: one JSON line per request from `handle` with route id, method, status, duration in ms, a request id, and a hashed user id.
  2. `Server-Timing` on grade and on Quest move and next, so devtools and e2e can read server time.
  3. `handleError` in `hooks.server.ts`: log the error with the request id, and show that id on the error page so a report can be matched to a log line.
  4. Domain events as log lines: harvest round (done, failed, remaining, elapsed), import (cards, warnings), grade refused or retried, and AI batch submitted or completed with token counts once AI-A lands.
  5. A latency check in CI: time 50 grades and 50 Quest moves against the CI database and fail above the PRD targets.
  6. Decision for Cooper: where logs and alerts go beyond Vercel's runtime log (a log drain, an error tracker such as Sentry, or OpenTelemetry). Decide before adding any dependency.
- **Don't.** Log emails, session tokens, card text or harvested page text. Log the SQL of a failed query (`hooks.server.ts` already strips it, because it carries the session id).
- **Acceptance.** A unit test feeds the logger a request carrying an email, a session cookie and card text, and asserts none appear in the output. An e2e test asserts `Server-Timing` on `/api/review/grade`. A test asserts the id on the error page matches the logged one. Each fails on `main`.

### CRD-A: Card editor for phone and desktop

- **Type** epic · **Size** L (write a short layout note first) · **Depends** none.
- **Why.** Cards is the surface used daily, and today no card can be created, edited, moved to another deck or retagged in the app. The only way in is an Anki export, and a typo found mid-study stays. Anki's browser and editor are the reference: a searchable list with an editor beside it. Its UI is dated, and it does not work on a phone. PRD P0-5 (card CRUD) and CRD-4 (`E` to edit) call for this.
- **What exists.** `/cards/deck` has a read-only browser with search, tag and state filters, four sorts and 50 cards per page (`src/lib/components/deck/CardBrowser.svelte`, `src/lib/server/cards/browse.ts`).
- **Scope, amended by Cooper on 2026-10-12** to match PR 361. The editor lives in a new global browser at `/cards/browse`, as in Anki, because search and bulk moves span decks. The deck page's list links into it. The original ask was to build the editor inside `/cards/deck`. Anki's flags, suspend, forget, find and replace and bulk actions came in with it.
- **Where.** `src/routes/cards/browse/*`, `src/lib/components/editor/*`, `src/lib/server/cards/edit.ts` (every write), `src/lib/cards/{edit,sanitize}.ts` (rules and the sanitizer, shared with the browser), `src/lib/server/cards/{browse,repo,stats}.ts`, `src/lib/components/study/Flashcard.svelte` (for the preview), and links in from the deck page, Study, Quest and harvest.
- **Do.**
  1. Layout. Desktop at 1024px and wider: the list on the left, the editor on the right, the selection in the URL (`?card=<id>`, `?new=1`) so reload and Back work. Phone: the list full screen, and a tap opens the editor as a full-screen sheet with a sticky Save bar above the keyboard. 44px targets and no horizontal scroll at 360px, the same rule as Quest (QST-5).
  2. Fields. Front and back, each with a small toolbar (bold, italic, code, link, list) and a live preview rendered by `Flashcard.svelte`, exactly as Study shows it. A deck picker with typeahead over existing decks plus "New deck". Tag chips with typeahead over existing tags.
  3. Actions. Create a card (a button on `/cards` and in the browser, and `N` in the browser). Edit. Change deck. Delete, with an undo toast. `E` during study opens the current card and returns to it after Save.
  4. Anki's browser operations. Filters by deck, tag, state (suspended included) and flag. Sorts by date added and date edited. On the checked cards: move, add or remove tags, flag (Anki's seven colours), suspend and unsuspend, forget, find and replace in text, delete. An Info tab with dates, FSRS state and review history.
  5. Server. Form actions in `src/routes/cards/browse/+page.server.ts`, writes in `src/lib/server/cards/edit.ts`. Every save goes through `sanitizeCardHtml`, the one HTML write path (TDD §7.2). A new card gets a random GUID, stored in `anki_guid`, and an id from `internalId`, so export to Anki (P1-A) keeps a GUID. After a deck or tag change, re-sync the Quest graph under `questLock`, as `importDeck` does. Undo restores from a server-side copy (`card_trash`, 24 hours), never from the browser. A re-import keeps a card edited in the app as it is, since a TSV export carries no modification time.
  6. Look. Use the tokens in `src/app.css` and the Study UI's components. Show keyboard shortcuts inline. Check dark and light themes.
- **Don't.** Store unsanitized HTML, even briefly. Reset review state on an edit (Anki keeps the schedule when text changes). Add a rich-text editor dependency before checking whether about 30 lines of `contenteditable` plus the sanitizer cover the toolbar. Run a user's regex on the server: find and replace is literal text.
- **Acceptance.** DB tests: a save containing `<script>` and `onerror=` stores sanitized HTML. An edit leaves `review_state` byte-equal. A deck change moves the card and its Quest edges. Undo restores the card, its schedule and its history, and nothing after 24 hours. A suspended card leaves rounds and due counts. A re-import leaves an in-app edit alone. e2e at 1440px and 390px wide: create a card, find it by search, edit its back, and see the change in Study. e2e: a bulk action, a flag, a suspend and an Undo keep the URL's filters and open card. Each fails on `main`.

### BMX-A · Human: Decide what a bookmark becomes

- **Gate** product decision · **Depends** none.
- **Why.** Accepting a harvested page today creates a flashcard (`kind='card'`, `src/lib/server/bmx/queue.ts:302`). Nothing writes `kind='doc'`, and Quest loads only cards and concepts. So bookmarks reach the graph only by entering the review queue, which PRD Q6 and HRV-8 say must not happen. AI-A needs this answered before it runs on bookmarks.
- **Options.** (a) Bookmarks become `doc` nodes with no review state, shown in Quest as open rooms. (b) Bookmarks stay cards, and Cooper accepts them into review. (c) Bookmarks stay out of the graph until promoted.
- **Acceptance.** Cooper records the pick here. BMX-B and AI-A follow it.

### AI-A: Enrichment-lite

- **Type** epic · **Size** L · **Depends** OPS-1 (API key), DATA-C (the pattern), BMX-A and BMX-B if it covers bookmarks. Can start on cards alone.
- **Why.** Quest's map is decks and tags today. PRD AI-3 and AI-4 want per-node summaries and concepts, and edges between related nodes, so the map has more than one path between rooms.
- **Where.** New `src/lib/server/ai/`. The graph sync in `src/lib/server/quest/repo.ts` owns only `provenance='import'` edges, so AI edges carry `provenance='ai'`.
- **Do.**
  1. Write a design note first (append to TDD §10 and delete the stale `claude-opus-4-8` sketch there). Pick the model then, from the current Claude family (for example `claude-haiku-5-5` for bulk extraction, `claude-sonnet-5-5` if quality needs it). Check current ids and prices in the Anthropic docs at implementation time.
  2. One Message Batches job with structured output `{summary, concepts[], difficulty}` per card. No `tools` array: that absence is the prompt-injection control (TDD §7.5). Corpus text goes in the user turn as delimited data, never in the system prompt.
  3. Start and poll the batch from a page action, the way `/harvest` drives its queue. No cron. Use DATA-C's claim, commit, call, commit shape. Never call the API inside the request transaction.
  4. `similar_to` edges from concept overlap in SQL, capped at 8 per node (AI-4). No embeddings in this pass.
  5. A per-user token budget checked before submitting (AI-7).
- **Don't.** Add a cron, a jobs table, an embeddings provider, or `api/extract.py`. Each was superseded (see [Deferred and cut](#deferred-and-cut)).
- **Acceptance.** Unit tests for prompt construction (untrusted text is delimited, no tools) and for edge derivation (cap of 8, no self-edges). A DB test that a budget-exceeding submit is refused. Then AI-B.

### AI-B · Human: Read 20 AI edges

- **Gate** B3 · **Depends** AI-A.
- **Why.** A model will report "400 edges written" and call it done. Only a human can tell whether the edges are meaningful or all say "both about the brain" (TDD R1).
- **Acceptance.** Cooper reads 20 random AI edges and records the verdict here: keep, tune, or drop.

### BMX-B: Keep the article text

- **Type** epic · **Size** M · **Depends** BMX-A, DATA-C.
- **Why.** Harvest keeps a 600-character excerpt and a content hash, then discards the article text (`queue.ts:151`). Triage and enrichment would have to fetch every page again: twice the load on each site, and some pages will be gone or paywalled by then.
- **Where.** `src/lib/server/bmx/queue.ts`, `src/lib/server/db/schema.ts` (`harvests`), a new migration.
- **Do.** Store the extracted text, clipped to about 8,000 characters through `truncate` in `extract.ts`, in a new `harvests.text` column. If BMX-A picks (a), write accepted harvests as `kind='doc'`.
- **Acceptance.** A DB test: a full-tier harvest stores its text, well-formed, at most the cap.

### BMX-C: Triage as a suggestion

- **Type** epic · **Size** M · **Depends** OPS-1 (API key), BMX-B.
- **Why.** PRD HRV-4 and HRV-5 call for Claude to propose a deck and tags, and to auto-file at confidence 0.7 or higher. Every `articles.csv` backfill row is metadata tier, which HRV-5 caps at 0.6, so all 3,861 go to human review anyway. Auto-filing would only ever touch freshly pasted full-tier pages.
- **Do.** Pre-fill the existing accept form's deck and tag pickers with a constrained suggestion (the user's existing decks and tags plus `__new__`, TDD §6.2). Skip auto-filing.
- **Acceptance.** A unit test that the structured-output schema's enum is built from the user's vocabulary. An e2e test with a stubbed model that the form opens pre-filled.

### AI-D: Suggest cards from a harvested article

- **Type** epic · **Size** M · **Depends** AI-A (client, guard and budget), BMX-B (stored article text), CRD-A (the editor is where a suggestion is reviewed).
- **Why.** PRD HRV-8: a harvested page becomes a card only when the user accepts one. Nobody will hand-write questions for 3,861 bookmarks. A model proposing one to three cards per article, edited in CRD-A's editor before saving, is how bookmarks reach review without flooding it (PRD Q6).
- **Where.** `src/routes/harvest/*`, `src/lib/server/ai/` (from AI-A), the CRD-A editor.
- **Do.** On a ready harvest, "Suggest cards" sends the stored text as delimited untrusted data and asks for structured output: up to three `{front, back, tags}`, tags constrained to the user's existing tags plus `__new__`. The suggestions open in the editor, prefilled. Nothing is saved until the user presses Save.
- **Don't.** Save a suggestion automatically. Give the model tools.
- **Acceptance.** A unit test that the article text appears only inside the delimiter and the request has no `tools`. An e2e test with a stubbed model: suggest, edit, save, and the card appears in its deck.

### AI-C: Design `prereq_of`

- **Type** epic, design first · **Size** L · **Depends** AI-B.
- **Why.** Quest's engine already honours `prereq_of` (a prerequisite seals what it points at, `engine.ts`), and the TDD calls it what gives the map a gradient. Nothing produces these edges, and the enrichment schema has no field for them. A per-card call cannot see other cards, so it cannot rank them.
- **Do.** Write the mechanism as a design note first, for example one call per deck that orders its concepts. Review it with `adv-dr` before building.
- **Acceptance.** The design note passes review. Building it gets its own card.

---

## 3. Other epics and gates

### QST-A · Human: Playtest Quest on a phone

- **Gate** B4 · **Depends** none · **Evidence** Confirmed not run: no record in any PR.
- **Why.** Quest's core loop is built and tested (`e2e/quest.test.ts`), but nobody has played it on a phone. Its door threshold (θ = 1.0, PRD Q2) is a taste call. The result also decides how much AI-A is worth: if the deck-and-tag map is already fun, enrichment is polish. If it is flat, enrichment is the fix.
- **Do.** On a phone, import the real decks, play 20 encounters. Note: is the next door obvious, does a missed card's cooldown feel fair, are the targets reachable with a thumb. Also add to the Home Screen once ([#346](https://github.com/cooperability/remediate.app/pull/346) deferred this device check): launch, rotate, launch in airplane mode, log out online and offline.
- **Acceptance.** A short note in the QST-B card (or a new card) with what to change.

### QST-B: Quest onboarding

- **Type** epic · **Size** M · **Depends** QST-A for specifics, but can start now.
- **Why.** [#345](https://github.com/cooperability/remediate.app/pull/345) records that Quest's first user could not tell how it works. A surface nobody understands has no users, whatever the engine does.
- **Where.** `src/routes/quest/+page.svelte`, `src/lib/components/quest/*`.
- **Do.** A first-visit walkthrough of the three door states (open, locked, sealed) and the Next button, dismissible and remembered per user. Keep it inside the CSP (no inline script).
- **Acceptance.** An e2e test: a new user sees the walkthrough on first `/quest` load, dismisses it, and does not see it on reload.

### CRD-C: Undo the last grade

- **Type** epic · **Size** M · **Depends** DATA-A (undo touches the same write path), DATA-B (a finished round's standing must not keep counting a grade that was undone).
- **Why.** PRD CRD-5. A mis-tapped rating has no fix today, and FSRS learns from it.
- **Where.** `src/lib/components/study/keys.ts` (handles flip and 1-4 only), `src/routes/cards/study/*`, `src/lib/server/cards/review.ts`, `src/lib/server/cards/repo.ts`.
- **Do.** `U` undoes the last grade of the current round: restore the prior `review_state` from the newest `review_log` row and delete that row, under the card lock. One level of undo.
- **Don't.** Add a second FSRS write path. Undo restores stored state. It does not run the scheduler backwards.
- **Acceptance.** A DB test: grade, undo, and `review_state` equals its pre-grade value byte for byte. An e2e test: `U` after a grade shows the same card again. Both fail on `main`.

### QST-D: Make Quest scale with tag count

- **Type** bug, performance · **Size** M · **Depends** none · **Evidence** Confirmed: measured by a reviewer on a local machine.
- **Why.** The map layout's concept spread compares every pair of tags and halls for up to 80 rounds. For 5,000 cards, the reviewer measured 100 ms at 500 tags, 245 ms at 1,000, 750 ms at 2,000, and 2,834 ms at 4,000. It runs inside `loadWorld` while the user's advisory lock is held, so every Quest request queues behind it. The cache is per server instance, so every cold start pays. PRD §9 targets room transitions under 200 ms. The existing budget test uses 90 tags, so it cannot catch this.
- **Where.** `src/lib/server/quest/layout.ts:144-177` (all-pairs loop), `:239-290` (the grid the card pass already uses), `:16-18` (a stale performance claim), `src/lib/server/quest/layout.test.ts:111`.
- **Do.** Replace the all-pairs relaxation with the grid neighbour search. Keep output deterministic. Correct the header comment.
- **Acceptance.** A test with 5,000 cards, 4 decks and 4,000 tags finishes inside the existing 400 ms budget. It fails on `main`. Determinism and spacing tests stay green.

### SEC-C: Security headers and a graded deploy

- **Type** epic · **Size** S · **Depends** OPS-1 (domain).
- **Why.** PRD success criterion 7 is a strict CSP and an A on securityheaders.com. The CSP is in place (`vite.config.ts`, nonce mode `auto`). `vercel.json` sets only `X-Content-Type-Options` and `X-Frame-Options`. Referrer-Policy, Permissions-Policy and HSTS are missing. Probable grade below A without them (based on what that site checks, not run). No signed-in response sets `Cache-Control`, so a shared browser's Back button may show the previous user's page after logout (Unverified, not traced in a browser).
- **Where.** `src/hooks.server.ts`, `vercel.json` (holds the two existing headers), `src/service-worker.ts` (it reads the referrer for POST redirects: check it still works under the chosen Referrer-Policy).
- **Do.** Set Referrer-Policy, Permissions-Policy and HSTS in `hooks.server.ts` with `response.headers.set`, so `vite preview` and the e2e suite see them. `vite preview` never applies `vercel.json`. Move the two existing headers there too, so one place owns them. Add `Cache-Control: private, no-store` to signed-in responses. Then Cooper runs securityheaders.com on the production domain.
- **Acceptance.** An e2e test asserts the headers on `/` and `no-store` on `/cards`. It fails on `main`. The PWA tests stay green.

### P1-A: Media, `.apkg` and export

- **Type** epic · **Size** L · **Depends** none.
- **Why.** PRD §7.2. Cards that reference images render a placeholder today ([#322](https://github.com/cooperability/remediate.app/pull/322)). The CSP allows `img-src https:` for imported images, which discloses the reader's IP to the image host. Export back to Anki is the round-trip promise.
- **Do.** Split into cards when picked up: media upload to Vercel Blob with src rewriting (then tighten `img-src`), `.apkg` import with decompression limits (PRD SEC-9), TSV export with formula-injection escaping (SEC-3 in the PRD).

---

## 4. Minor bugs, tests and cleanup

### BMX-D: Harvest politeness and parsing fixes

Each item is small. Batch them or take one at a time. Evidence for all: a reviewer probe against loopback servers or the real module, labelled per item.

| Item                                               | Where                                                     | Failure                                                                                                   | Acceptance                                                           |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unreachable robots.txt means allow, cached an hour | `harvest.ts:39-47`                                        | RFC 9309 §2.3.1.4 says assume disallow. A robots timeout still fetches the page. Confirmed.               | A robots fetch that times out gives a `failed` row and no page fetch |
| Robots rules compared without percent-encoding     | `robots.ts:79-81`                                         | `Disallow: /%7Ejoe` allows `/~joe`. Confirmed by probe.                                                   | Both forms block                                                     |
| Per-domain spacing resets every round              | `queue.ts:185`                                            | Auto-continue and a second tab hit one site under 1 s apart. The page promises one per second. Confirmed. | Two back-to-back rounds sharing a domain are at least 1 s apart      |
| Attribute regex is quadratic per tag               | `extract.ts:76-83`                                        | 1 MB of long `<meta>` tags takes about 1.6 s of CPU. Confirmed by probe.                                  | That input under 300 ms                                              |
| Pasting drops links silently                       | `normalize-url.ts:53,61`, `harvest/+page.server.ts:41-44` | Over-long URLs and URLs with credentials vanish, and the UI says "Queued 1 link." Confirmed.              | The message counts skipped links                                     |
| `<meta charset="utf-16">` decoded as UTF-16        | `ssrf.ts:191-202`                                         | WHATWG maps it to UTF-8. The page lands `failed` as mojibake. Confirmed.                                  | The body decodes as UTF-8                                            |
| Redirect bodies keep downloading                   | `ssrf.ts:159-161`                                         | `res.resume()` drains a redirect body until the timeout. Confirmed.                                       | `res.destroy()`, and server write count flat after return            |
| Generic titles collide as duplicates               | `harvest.ts:59-68`                                        | Soft-404 pages from two sites hash equal and one is marked duplicate. Rows stay visible. Confirmed.       | Hash includes the domain for metadata-only rows                      |

### PWA-A: Offline and installed-app follow-ups

| Item                                | Where                                         | Failure                                                                                                                                        | Acceptance                                                                            |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Offline logout fails silently       | `service-worker.ts:39`, `static/offline.html` | Tapping Log out offline shows the offline page. "Try again" reloads with GET, the session survives, and nothing says so. Confirmed by reading. | A signed-in offline logout shows "You are still signed in" (extend `e2e/pwa.test.ts`) |
| Offline link tap shows the 500 page | `src/routes/+error.svelte`, worker            | Deferred in [#346](https://github.com/cooperability/remediate.app/pull/346).                                                                   | An offline client navigation shows the offline message                                |
| POST body forwarding untested       | `service-worker.ts`                           | A worker that dropped the body would pass the suite and break delete deck. Noted in #346.                                                      | A test that a POST through the worker keeps its body                                  |
| No kill switch for a bad worker     | `service-worker.ts`                           | A fixed worker reaches an installed app only after every window closes. Noted in #346.                                                         | Design note first                                                                     |

### QST-E: Quest polish

| Item                                                                              | Where                                           | Failure                                                                                                                                                                                                                             | Acceptance                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A stale tab's refused click does not refresh                                      | `src/routes/quest/+page.svelte:102-116,155-166` | After another tab moves the run, every door in the stale tab answers 409 until reload. Confirmed by reading.                                                                                                                        | On a 409, the page refetches `/api/quest` (two-page e2e)                  |
| Human decision: a card rated Hard or Good at first meeting never returns in Quest | `engine.ts:256-260,417`                         | FSRS leaves it in learning (state 1) with stability above θ, so the door is open and `suggest` skips it. A Quest-only player never reviews it. The code comment says this is deliberate. Cooper decides before an agent touches it. | Decide, then offer an overdue state-1 card as a review, or record why not |
| "80% known" is a literal                                                          | `src/lib/components/quest/Encounter.svelte:169` | Drifts from `CLEAR_SHARE` in `src/lib/quest/types.ts:171`.                                                                                                                                                                          | Uses the constant                                                         |

### CRD-B: Cards and auth minor fixes

| Item                                                | Where                                     | Failure                                                                                                             | Acceptance                                                                                                         |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Two first logins at once give a 500                 | `src/routes/login/+page.server.ts:24-28`  | Both insert the new user, the second hits the unique email index. Probable.                                         | `insert … on conflict (email) do nothing`, then select. A DB test with two concurrent logins expects two redirects |
| A first data row starting with `#` vanishes         | `src/lib/server/ingest/anki-tsv.ts:57-60` | `#1 rule\tback` as the first row is read as preamble and dropped without a warning. Confirmed by probe.             | Preamble parsing stops at the first line that is not `#key:value`, or warns                                        |
| Imported HTML may carry `class`                     | `src/lib/cards/sanitize.ts:58`            | A hostile shared deck can use the app's utility classes, for example a full-screen link over the study screen. Low. | `class` dropped except the `media-missing` the hook sets at `:18`                                                  |
| Postgres may reject a time zone the browser accepts | `budget.ts:16`, `stats.ts:163`            | Hypothesis: Node's ICU and Postgres tzdata can disagree.                                                            | Validate the cookie against `pg_timezone_names`, or fall back to UTC on error                                      |

### TEST-A: Tests that cannot fail today

For each line below, deleting it fails no test. Each needs a test that does.

| Line                                                             | Behaviour                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/hooks.server.ts:34-38`                                      | Removing an address from `ALLOWED_EMAILS` ends its sessions         |
| `src/routes/login/+page.server.ts:20` (`!isAllowed(email) \|\|`) | The allowlist itself. No test calls the login action                |
| `src/lib/server/auth.ts:46-59`                                   | Session expiry and renewal. There is no `auth.test.ts`              |
| `src/lib/server/cards/repo.ts:331` (`.for('update', …)`)         | The card lock (covered by DATA-A's test once it lands)              |
| `src/lib/server/bmx/queue.ts:184` (`skipLocked: true`)           | The overlap test passes with plain `FOR UPDATE` too                 |
| `src/lib/server/bmx/queue.ts:207`                                | `markDuplicates` after a fetch round                                |
| `src/lib/server/bmx/ssrf.ts:70`                                  | Refuse when any DNS record is private, not just the first           |
| `src/lib/server/bmx/harvest.ts:48,110`                           | Robots cache eviction, timeout reason text                          |
| `src/lib/server/quest/repo.ts:531`                               | A grade filtered to the user's own log (no cross-tenant Quest test) |
| `src/lib/server/quest/layout.ts:314`                             | The layout cache hit                                                |
| `src/lib/server/quest/engine.ts:134`                             | The tag-to-tag cycle guard                                          |

### CLEAN-A: Remove orphaned schema and config

- **Type** cleanup · **Size** S · **Depends** none. The `vector(1024)` part depends on AI-B.
- **Why.** Dead config misleads the next agent into building against it.
- **Do.** A migration drops `login_code` and `jobs`, and the unused `sends` column of `login_throttle` (SEC-A counts failures in that table, so the table stays). Delete `INTERNAL_TOKEN` from `.env.example`. Rename `src/lib/server/otp.ts`, which holds no one-time-password code since [#330](https://github.com/cooperability/remediate.app/pull/330). Drop the `vector(1024)` column only if AI-B decides against embeddings.
- **Acceptance.** `yarn db:generate` is clean after the migration, and `grep -r INTERNAL_TOKEN` finds only history.

## Deferred and cut

Decided against, or parked for a reason. Do not build these from PRD, TDD or PIPELINE text without reopening the decision here.

| Item                                        | Decision            | Why                                                                                                                                                                          |
| ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/extract.py` (Python extractor)         | Cut                 | Extraction shipped in TypeScript (`src/lib/server/bmx/extract.ts`). The SSRF guard runs in the socket's DNS lookup, which also closes the DNS-rebinding gap TDD R6 accepted. |
| Cron worker, `/api/jobs/tick`, `jobs` table | Cut                 | The harvest queue is request-driven from `/harvest`. AI-A uses the same shape.                                                                                               |
| `INTERNAL_TOKEN`                            | Cut                 | Its only consumer was `api/extract.py`.                                                                                                                                      |
| `POST /api/import` returning 202 and a job  | Cut                 | Import is a synchronous form action with a 4 MB cap, under Vercel's 4.5 MB request limit. The real corpus imports well inside one request.                                   |
| Storybook                                   | Cut                 | Removed in Phase 0. No component tests replaced it. Playwright covers key states.                                                                                            |
| Embeddings and pgvector similarity          | Deferred until AI-B | No embeddings provider is chosen. Concept overlap may be enough.                                                                                                             |
| Auto-filing harvests (HRV-5)                | Deferred            | See BMX-C: the 0.6 cap on metadata rows means it would rarely fire.                                                                                                          |
| Argon2id passwords, passkeys (PRD SEC-7)    | Deferred            | Login is a shared password by choice ([#330](https://github.com/cooperability/remediate.app/pull/330)). SEC-A covers the immediate risk.                                     |

## Done

Shipped work, newest first, so a cold reader can tell built from planned.

| What                                                                                                                                                                                                                                                                                                                                                                                                          | PR                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Signed-out demo (PRD QST-6, reshaped): "Try the demo" on the landing page makes a guest tenant holding the two AI-made decks, so Cards, Browse and Quest run unchanged under RLS. Guests expire after 24 hours and each new start purges up to 10 expired ones. Caps: 100 live guests, 5 starts per hour per hashed IPv4 address or IPv6 /64. Import and harvest stay closed to guests.                       | [#389](https://github.com/cooperability/remediate.app/pull/389)                                                                         |
| Login refuses an address after 5 failed attempts in 15 minutes (SEC-A). The allowlist and password checks both run on every attempt.                                                                                                                                                                                                                                                                          | [#365](https://github.com/cooperability/remediate.app/pull/365)                                                                         |
| Harvest: a gzip, deflate or brotli body cut off mid-stream fails fast instead of hanging past the timeout. Text written to jsonb never holds half a surrogate pair. Pasted URLs keep apostrophes. The Acronyms deck gains a WHATWG card. An import with no deck name files under Default. `/api/review/finish` answers a `null` body with 400. Dependabot stops proposing `isomorphic-dompurify` past 2.26.0. | [#356](https://github.com/cooperability/remediate.app/pull/356)                                                                         |
| PWA: icons, launch screens, offline page, standalone launch from the iOS Home Screen                                                                                                                                                                                                                                                                                                                          | [#346](https://github.com/cooperability/remediate.app/pull/346)                                                                         |
| Pin `isomorphic-dompurify` so signed-in pages load on Vercel                                                                                                                                                                                                                                                                                                                                                  | [#345](https://github.com/cooperability/remediate.app/pull/345)                                                                         |
| Quest core loop: the map is the graph, recall opens doors, one review write path                                                                                                                                                                                                                                                                                                                              | [#327](https://github.com/cooperability/remediate.app/pull/327)                                                                         |
| BMX harvest queue, `/harvest` review page, `articles.csv` backfill                                                                                                                                                                                                                                                                                                                                            | [#325](https://github.com/cooperability/remediate.app/pull/325)                                                                         |
| BMX harvest core: URL normalizer, SSRF-safe fetch, robots.txt, tiered extraction                                                                                                                                                                                                                                                                                                                              | [#324](https://github.com/cooperability/remediate.app/pull/324)                                                                         |
| Interval preview on each rating button (CRD-2)                                                                                                                                                                                                                                                                                                                                                                | [#323](https://github.com/cooperability/remediate.app/pull/323)                                                                         |
| Delete a deck                                                                                                                                                                                                                                                                                                                                                                                                 | [#326](https://github.com/cooperability/remediate.app/pull/326)                                                                         |
| Shared `DEV_PASSWORD` login replaces emailed codes                                                                                                                                                                                                                                                                                                                                                            | [#330](https://github.com/cooperability/remediate.app/pull/330)                                                                         |
| Cards: dashboard, study UI, per-deck FSRS rounds, grading artifact, local Postgres tooling                                                                                                                                                                                                                                                                                                                    | [#309](https://github.com/cooperability/remediate.app/pull/309), [#310](https://github.com/cooperability/remediate.app/pull/310)        |
| Phase 0: FastAPI and Neo4j cut, app promoted to the root, Anki ingest                                                                                                                                                                                                                                                                                                                                         | [#282](https://github.com/cooperability/remediate.app/pull/282)                                                                         |
| RLS on every tenant table, migrations from empty in CI, CSP with nonces, lint, typecheck, unit, database and e2e tests in CI                                                                                                                                                                                                                                                                                  | [#282](https://github.com/cooperability/remediate.app/pull/282) through [#327](https://github.com/cooperability/remediate.app/pull/327) |
