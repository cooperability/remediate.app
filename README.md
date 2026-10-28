# Remediate

Remediate turns a personal knowledge corpus into one connected graph and exposes it through surfaces that share a single backend.

- **BMX** (BookMark eXtractor) harvests URLs. Paste links, and their content is fetched, extracted, and queued for you to file into the graph with a deck and tags. Claude triage is planned. This is the project's original vision.
- **Cards** is an Anki-compatible spaced-repetition surface fed by your existing decks.
- **Quest** is an exploratory game played over the same graph, where rooms are concepts and doors are relationships.

The scheduler's memory model and the game's progression gate are the same column in the same table.

Read [docs/ROADMAP.md](docs/ROADMAP.md) for what to build next, in priority order. Read [docs/PRD.md](docs/PRD.md) for what and why, and [docs/TDD.md](docs/TDD.md) for how.

## Systems

Status is a separate channel from kind. Green and a solid border means it exists in the tree today. Grey, a dashed border, and a `planned` edge label means it is not started.

```mermaid
flowchart TD
  classDef built fill:#dff5e1,stroke:#2e7d32,color:#1b3d20
  classDef planned fill:#f2f2f2,stroke:#9e9e9e,color:#3d3d3d,stroke-dasharray:4 3

  owner((Owner)):::built
  anki[(Anki TSV)]:::built
  paste(["Paste URLs or articles.csv"]):::built

  subgraph vercel ["Vercel one project"]
    ssr[SvelteKit SSR]:::built
    ingest[Anki ingest]:::built
    cards[Cards]:::built
    quest[Quest]:::built
    bmx[BMX harvest]:::built
    enrich["AI enrichment and triage"]:::planned
  end

  pg[("Neon Postgres with RLS")]:::built
  claude{{"Claude API"}}:::planned
  web{{"Untrusted URLs"}}:::built

  owner --> ssr
  anki --> ingest
  owner --> paste
  paste --> bmx
  ssr --> cards
  ssr --> quest
  ssr --> bmx
  ingest --> pg
  cards --> pg
  quest --> pg
  bmx --> pg
  bmx -->|SSRF-guarded fetch| web
  ssr -.->|planned| enrich
  enrich -.->|planned| claude
  enrich -.->|planned| pg
```

VS Code built-in preview shows the fence as a code block. The Markdown Preview Mermaid Support extension renders it. GitHub renders it natively.

| Status  | Meaning                                                 |
| ------- | ------------------------------------------------------- |
| Built   | In the tree and exercised                               |
| Planned | Not started. Drawn so absence is not read as accidental |

What exists today: Anki import, Cards (FSRS rounds, interval previews, stats, deck delete), Quest's core loop over a graph built from decks and tags, BMX harvest with a review queue and the `articles.csv` backfill, row-level security on every tenant table, and an installable PWA. AI enrichment, Claude triage, card edit and undo, and anonymous play are not built. [docs/ROADMAP.md](docs/ROADMAP.md) ranks what is left.

### Boundary: browser to Vercel

The user hits one origin. SvelteKit `+server.ts` routes and form actions are the API. A second HTTP service would add a second auth boundary and a hop inside our own app. That is why `backend/` is gone.

### Boundary: harvest fetch

BMX fetches arbitrary user-supplied URLs. That is SSRF by construction. The fetch runs inside the main SvelteKit function, which holds the database credentials, so the guard is the only wall. `src/lib/server/bmx/ssrf.ts` checks every address inside the socket's own DNS lookup, so the address checked is the address connected to. It refuses private, loopback, link-local and metadata ranges, ports other than 80 and 443, and credentials in the URL, and it re-checks every redirect hop. Bodies are capped at 2 MiB after decompression. The design docs once planned a separate Python extractor with no database credentials. It was never built, and [docs/ROADMAP.md](docs/ROADMAP.md) records it as cut.

### Boundary: app to Neon

Every table carries `user_id` on the row, so RLS attaches without a join. Migration `0003_rls` does that (see Local development).

## Run it locally

Requires Node 22 and Corepack. The server refuses to start without `DATABASE_URL`, so set up the database in Local development below. No API keys are needed. `isomorphic-dompurify` is pinned to 2.26.0 because later versions load jsdom 27+, which Vercel's runtime cannot load ([#345](https://github.com/cooperability/remediate.app/pull/345)).

```bash
git clone https://github.com/cooperability/remediate.app.git
cd remediate.app
corepack enable
yarn install --frozen-lockfile
yarn dev          # http://localhost:3000
```

Same loop inside Node 22, when you want isolation or the host has no Node:

```bash
./scripts/container yarn dev
```

`scripts/container` is the one Docker entry point. There is no Dev Container and none is coming back. If `docker info` fails, start Docker Desktop and retry. A client-only `docker version` is not enough.

Keep the clone off OneDrive. A OneDrive-backed checkout makes file watchers and bind mounts unreliable, and an editor pointed at a second clone will report failures the real tree does not have.

Parser ground truth for `source_data/`. `anki-tsv.test.ts` asserts the Anthro and CompSci counts. The Acronyms deck ([#305](https://github.com/cooperability/remediate.app/pull/305)) was counted with `csv-parse` on 2026-10-11, and no test asserts it yet. Raw lines is what splitting on newlines returns, the count a line-based parser would wrongly treat as records.

| File     | Raw lines | Records | Unique GUIDs | Multiline backs |
| -------- | --------: | ------: | -----------: | --------------: |
| Anthro   |      4053 |     320 |          320 |             123 |
| CompSci  |       576 |     137 |          137 |              23 |
| Acronyms |       326 |     319 |          319 |               0 |
| Total    |      4955 | **776** |      **776** |                 |

| Command                     | Does                                           |
| --------------------------- | ---------------------------------------------- |
| `yarn lint`                 | Prettier check plus ESLint                     |
| `yarn run check`            | `svelte-check` against `tsconfig.json`         |
| `yarn test:server`          | Unit tests, plus database tests with a DB      |
| `yarn test:e2e`             | Playwright                                     |
| `yarn test`                 | Both of the above                              |
| `yarn db:push`              | Push the Drizzle schema (needs `DATABASE_URL`) |
| `./scripts/container <cmd>` | Same commands in a Node 22 image               |

Type `yarn run check` in full. Plain `yarn check` runs Yarn 1's built-in integrity check, not the script.

## Local development

1. `yarn db:up` starts Postgres 17 with pgvector on port 5433 (`docker-compose.yml`).
2. `cp .env.example .env`, then set `DATABASE_URL="postgres://postgres:dev@localhost:5433/remediate"` and add your address to `ALLOWED_EMAILS` and set `DEV_PASSWORD`.
3. `yarn db:migrate` applies `drizzle/`. After a schema change, `yarn db:generate` writes the next migration.
4. `yarn db:seed you@example.com` creates that user and imports every `.txt` deck in `source_data/`, 776 cards across 3 decks. Rerunning it updates in place.
5. `yarn dev`, then log in with your address and `DEV_PASSWORD`.
6. `yarn db:down` stops the container and keeps the data volume.

Keep one database on one path. `db:migrate` records what it applied, and `db:push` does not, so a later `db:migrate` against a pushed database fails on tables that already exist. Use `db:push` only on a throwaway database.

With `DATABASE_URL` set, `yarn test:server` also runs the database tests (`*.db.test.ts` and `repo.test.ts`). They create and delete their own rows, and they need the schema from `db:migrate`. CI runs them, and the Playwright study-round test, against a Postgres service built with `db:migrate`. On 2026-10-11 this branch has 409 server tests. Without a database, 337 pass and 72 skip.

Signed-in requests run under Postgres row-level security. `hooks.server.ts` wraps each one in `asTenant` (`src/lib/server/db/index.ts`): a transaction that sets `app.user_id` and switches to the `remediate_app` role, which migration `0003_rls` creates with a `tenant` policy on every table that has `user_id`. The role that runs `db:migrate` needs `CREATEROLE`, which Neon's owner role has. A database built with `db:push` has no policies, so the app still works there, without the second wall.

Days, streaks, and the daily new-card cap follow the browser's time zone, which the app stores in a `tz` cookie on first load. Until then they use UTC.

## Deploy

GitHub Actions owns production. `.github/workflows/verify.yml` runs lint, typecheck, migrations from empty with a schema-drift check, `yarn test:server`, a build, and `yarn test:e2e` on Node 22 against a Postgres service. When it passes on `main`, `.github/workflows/deploy.yml` builds with the Vercel CLI, runs `yarn db:migrate` against production, deploys the prebuilt output, and fails unless `/api/health` reports `status: "ok"` within 3 minutes. The old deployment answers that check too, so a pass proves the database is reachable, not that the new build is serving. Building comes first, so a broken build never touches the database. One deploy runs at a time, because drizzle's migrator takes no lock. A verified commit that is no longer the tip of `main` is skipped. The newer commit deploys only if its own Verify passes.

Migrations run before the new code goes live, and the old code keeps serving if the deploy step fails. Every migration must work with the code already in production: add columns and tables first, and drop or rename them in a later deploy.

The Vercel Git integration still builds a preview on each pull request. `vercel.json` sets `git.deploymentEnabled.main` to `false`, so it no longer deploys `main`.

The deploy job reads these secrets from the GitHub `production` environment:

| Secret                  | Value                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`          | A Vercel access token with deploy rights on the project.                                 |
| `VERCEL_ORG_ID`         | `orgId` from `.vercel/project.json` after `vercel link`.                                 |
| `VERCEL_PROJECT_ID`     | `projectId` from `.vercel/project.json` after `vercel link`.                             |
| `DATABASE_URL_UNPOOLED` | The production Neon URL without the pooler, as Vercel's `STORAGE_DATABASE_URL_UNPOOLED`. |

Root Directory must be `.`. On 2026-09-16 project `prj_RnBD1bE2cYV61qnpATWrMV0qUnJI` still read `frontend`, and every build aborted before install. Probable fixed since: Vercel preview deployments now pass on open pull requests, and production served signed-in pages after [#345](https://github.com/cooperability/remediate.app/pull/345). Root Directory is a dashboard setting, and `vercel.json` cannot override it. The other settings are Node.js 22.x, framework preset SvelteKit, `yarn install`, `yarn build`.

## Configuration

Copy `.env.example` to `.env`.

| Variable            | Needed for                                                                   |
| ------------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`      | Neon Postgres with pgvector. Required: the server will not start without it. |
| `ALLOWED_EMAILS`    | Comma-separated addresses that may log in. Unset means nobody can.           |
| `DEV_PASSWORD`      | The shared login password. Unset means nobody can log in.                    |
| `ANTHROPIC_API_KEY` | Planned AI enrichment and BMX triage. Nothing reads it yet.                  |

`.env.example` still lists `INTERNAL_TOKEN`. Nothing reads it, and [docs/ROADMAP.md](docs/ROADMAP.md) tracks its removal.

## Source data

`source_data/` holds the real Anki exports and bookmark metadata, and doubles as the test fixture directory. Treat it as read-only. A find-and-replace across the repo will match URLs and identifiers inside `articles.csv` and `ArticleMetadata.db` and corrupt them.

## License

Copyright 2023-2026 Cooper Reed. Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal study, hobby projects, noncommercial research, and use by charities, schools, public research bodies and government all qualify. Commercial use needs a separate license: ask through [cooperability.com](https://cooperability.com).

The license does not cover the third-party text inside `source_data/`. The article metadata and the passages quoted in the Anki exports belong to their original authors.
