# Remediate — Product Requirements Document

**Status:** Draft v3 · **Date:** 2026-11-16 (v2: 2026-07-15) · **Target prototype:** 2026-07-19 (passed)
**Companion docs:** [TDD.md](./TDD.md) (how it's built) · [ROADMAP.md](./ROADMAP.md) (what is built, and what to build next, in priority order)

> **Read with ROADMAP.md.** These requirements are the target, written before the build. Cards, Quest's core loop and BMX harvest have shipped. Where the build departed from a requirement on purpose (auth, the Python extractor, the import job queue), ROADMAP's "Deferred and cut" table records the decision. Corrections in place are marked _As built_.

> **v2 changes:** renamed to Remediate (BMX survives as the harvest subsystem) · corpus ground-truthed (457 cards, not 212) · bookmark harvesting restored to P0 as the original vision · Cards explicitly precedes Quest · Anki GUID replaces content-hash as primary identity.

> **v3 changes:** a product thesis and an ordered audience ([§1.1](#11-thesis-and-stages)) · five loops, two of them unbuilt ([§3.4](#34-the-five-loops)) · adherence becomes a measured requirement ([§8.6](#86-measures)) · one card tests one thing (CRD-10, AI-8) · success criteria carry a status and a basis instead of a tick ([§12](#12-success-criteria)) · kill criteria ([§12.3](#123-kill-criteria)) · open questions Q7 to Q10 · the separate Anki PWA design is folded in here (§7.2, §7.3). Nothing added in v3 is built unless the line says so.

---

## Table of Contents

1. [The One-Paragraph Version](#1-the-one-paragraph-version)
   - 1.1 [Thesis and stages](#11-thesis-and-stages)
2. [Naming](#2-naming)
3. [Lay of the Land (diagrams first)](#3-lay-of-the-land)
   - 3.1 [Product surface map](#31-product-surface-map)
   - 3.2 [The core insight: one graph, three faces](#32-the-core-insight-one-graph-three-faces)
   - 3.3 [The two user journeys](#33-the-two-user-journeys)
   - 3.4 [The five loops](#34-the-five-loops)
4. [Problem & Motivation](#4-problem--motivation)
5. [Users & Jobs To Be Done](#5-users--jobs-to-be-done)
6. [The Corpus (ground truth)](#6-the-corpus-ground-truth)
7. [Scope](#7-scope)
8. [Feature Requirements](#8-feature-requirements)
   - 8.1 [Ingest — Anki](#81-ingest--anki)
   - 8.2 [Harvest — BMX bookmark pipeline](#82-harvest--bmx-bookmark-pipeline)
   - 8.3 [Cards — the Anki surface](#83-cards--the-anki-surface)
   - 8.4 [Quest — the game surface](#84-quest--the-game-surface)
   - 8.5 [AI enrichment](#85-ai-enrichment)
   - 8.6 [Measures](#86-measures)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Security Requirements](#10-security-requirements)
11. [Cost Model](#11-cost-model)
12. [Success Criteria](#12-success-criteria)
13. [Open Questions](#13-open-questions)

---

## 1. The One-Paragraph Version

**Remediate** turns a personal knowledge corpus — Anki decks, bookmarks, class notes, work knowledge — into a single connected graph, and exposes it through surfaces that share one backend. **BMX** (the BookMark eXtractor, the project's original vision) harvests URLs: you paste a pile of links, and their content is fetched, extracted, triaged by an LLM, and slotted into the graph with the right deck and tags. **Cards** is an Anki-compatible spaced-repetition surface you can feed your existing decks into. **Quest** is an exploratory adventure game played over the same graph, where rooms are concepts, doors are relationships, and progress is gated by actual recall. The idea that makes this one product rather than three: _the scheduler's memory model and the game's progression system are the same column in the same table._ Mastery is movement.

The name is the thesis. To **remediate** is to fix a gap — which is what spaced repetition does to memory. To **re-mediate** is to present material through a new medium — which is what the game does to a flashcard. It's playful and it's literal.

### 1.1 Thesis and stages

**Thesis: Remediate is a game whose only currency is retained knowledge.** Everything a player holds in the world is something they can still recall. One rule follows from that, and it binds every later feature: **the game never offers a reward the scheduler would not also want.** The door gate already works this way. A missed card stays sealed until FSRS says it is due, so grinding unlocks nothing ([TDD §9.1](./TDD.md#91-as-built-phase-6-groundwork)).

The product is built for one audience at a time. A stage starts only when the one before it passes.

| Stage | Audience                               | Passes when                                                    |
| ----- | -------------------------------------- | -------------------------------------------------------------- |
| 1     | The owner, daily                       | 20 active days in 28, held for 8 weeks ([MSR-1](#86-measures)) |
| 2     | One other person who studies seriously | They import their own deck and return in week 2 unprompted     |
| 3     | People like them                       | Stage 2 has passed with three people                           |

The technical evaluator in §5 is served by stage 1. A tool its author uses daily, with numbers to show for it, is the stronger exhibit.

---

## 2. Naming

| Thing             | Name                            | Notes                                                                                                                                                         |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product / domain  | **Remediate** — `remediate.app` | Owned. The deleted FastAPI service was titled `"Remediate.app Backend"`. That was intent, not leftover. v1 of this doc read it as cruft and was wrong.        |
| Repo              | `remediate.app`                 | Matches the domain exactly. See [TDD §12.1](./TDD.md#121-the-rename-safest-order) for the safe rename order.                                                  |
| Harvest subsystem | **BMX** (BookMark eXtractor)    | Kept deliberately. It's an accurate name for exactly one subsystem, and it preserves the project's origin story instead of erasing it. `src/lib/server/bmx/`. |
| SRS surface       | **Cards**                       |                                                                                                                                                               |
| Game surface      | **Quest**                       |                                                                                                                                                               |

---

## 3. Lay of the Land

### 3.1 Product surface map

```mermaid
flowchart TB
    subgraph SOURCES["📥 Sources"]
        direction LR
        S1["Anki .txt/.tsv export<br/>(457 real cards today)"]
        S2["<b>Bookmark URLs</b><br/>paste · HTML export · articles.csv<br/>(3,861 today)"]
        S3["Class notes · work knowledge<br/>(planned growth)"]
        S4["Agent push<br/>(Cursor / Claude Code / MCP)<br/>(P1, not built)"]
    end

    subgraph CORE["⚙️ Remediate Core — one backend"]
        direction TB
        ING["Anki Ingest<br/>RFC4180-TSV · sanitize · GUID"]
        BMX["<b>BMX Harvest</b><br/>SSRF-guarded fetch<br/>tiered extraction<br/>LLM triage → deck + tags"]
        G[("Knowledge Graph<br/>nodes · edges · embeddings<br/>Postgres + pgvector")]
        E["AI Enrichment<br/>Claude · async · batched<br/>(not built)"]
        R["Retrieval<br/>keyword + vector + graph walk<br/>(planned, no requirement yet)"]
        ING --> G
        BMX --> G
        G <--> E
        G --> R
    end

    subgraph FACES["🖥️ Surfaces"]
        direction LR
        F1["<b>1️⃣ Cards</b><br/>FSRS review queue<br/>deck browser · editor · stats"]
        F2["<b>2️⃣ Quest</b><br/>graph-as-map<br/>rooms · doors · encounters<br/>mobile-first"]
    end

    S1 --> ING
    S2 --> BMX
    S3 --> ING
    S4 --> BMX
    R --> F1
    R --> F2
    F1 -. "review events" .-> G
    F2 -. "review events" .-> G

    classDef src fill:#1e3a5f,stroke:#4a90d9,color:#e8f1fa
    classDef core fill:#2d1f3d,stroke:#9d6bc4,color:#f0e8fa
    classDef face fill:#1f3d2d,stroke:#4caf7d,color:#e8faf0
    class S1,S2,S3,S4 src
    class ING,BMX,G,E,R core
    class F1,F2 face
```

### 3.2 The core insight: one graph, three faces

The same row in the same table is a flashcard, a room, and a harvested article.

```mermaid
flowchart LR
    subgraph SHARED["Shared primitive"]
        N["<b>Node</b><br/>id · anki_guid · content<br/>embedding · kind"]
        ED["<b>Edge</b><br/>src → dst · kind · weight<br/>deck / tag / similar / prereq"]
        RV["<b>ReviewState</b><br/>FSRS: stability, difficulty,<br/>due, lapses"]
    end

    subgraph BMXR["Read as: BMX Harvest"]
        B1["Node = harvested doc"]
        B2["Edge = proposed deck/tag<br/>placement"]
        B3["(no ReviewState until<br/>promoted to a card)"]
    end
    subgraph CARDS["Read as: Cards"]
        C1["Node = flashcard"]
        C2["Edge(deck) = membership"]
        C3["ReviewState = when to show it"]
    end
    subgraph QUEST["Read as: Quest"]
        Q1["Node = <i>room</i>"]
        Q2["Edge = <i>door</i> to next room"]
        Q3["ReviewState = <i>is it unlocked?</i><br/>stability ≥ θ ⇒ passable"]
    end

    N --> B1 & C1 & Q1
    ED --> B2 & C2 & Q2
    RV --> B3 & C3 & Q3

    classDef shared fill:#3d2d1f,stroke:#d99a4a,color:#faf0e8
    classDef read fill:#1a1a2e,stroke:#666,color:#ccc
    class N,ED,RV shared
    class B1,B2,B3,C1,C2,C3,Q1,Q2,Q3 read
```

> **Why this matters:** a reader should see one idea, not three half-apps. Recall performance drives both the scheduler and the game's world state from a single write path. A harvested bookmark and a hand-written flashcard are the same kind of thing, so BMX's output is immediately reviewable _and_ immediately playable. Nothing is duplicated.

### 3.3 The two user journeys

**Journey A — BMX harvest (the original vision):**

> _As built:_ three steps below differ. The extractor is TypeScript in the same function, not a Python service. There is no cron worker: harvest rounds run inside the request from `/harvest`. No model call is built, so nothing is auto-slotted and every harvest waits for a human decision. ROADMAP's "Deferred and cut" table has each decision.

```mermaid
sequenceDiagram
    actor U as User
    participant W as Remediate Web
    participant API as API
    participant X as Extractor (Python)
    participant AI as Claude
    participant DB as Postgres

    U->>W: Paste 50 bookmark URLs
    W->>API: POST /api/bmx/harvest
    API->>DB: Insert 50 job rows (queued)
    API-->>W: 202 + job batch id
    Note over API,DB: Everything below is cold path

    loop per URL (cron worker)
        API->>X: extract(url)
        X->>X: SSRF guard → fetch → readability
        alt Full text reachable
            X-->>API: {tier:"full", text, title}
        else Paywalled / apple.news / blocked
            X-->>API: {tier:"metadata", title, description}
        end
        API->>AI: triage(content) → summary, concepts,<br/>proposed deck + tags, confidence
        AI-->>API: structured JSON
        alt confidence ≥ 0.7
            API->>DB: Auto-slot node + edges
        else low confidence
            API->>DB: Queue for human review
        end
    end

    U->>W: Review the triage queue
    W-->>U: "12 need a decision, 38 auto-slotted"
    U->>W: Confirm / re-deck / discard
    W->>API: POST /api/bmx/confirm
    API->>DB: Finalize placement
```

**Journey B — study, then play:**

```mermaid
sequenceDiagram
    actor U as User
    participant W as Remediate Web
    participant API as API
    participant DB as Postgres

    U->>W: Study (Cards)
    W->>API: GET /api/review/queue
    API->>DB: FSRS due query (indexed)
    DB-->>W: Next card
    U->>W: Rate Again/Hard/Good/Easy
    W->>API: POST /api/review/grade
    API->>DB: Update ReviewState

    U->>W: Play (Quest)
    W->>API: GET /api/quest/room
    API->>DB: Current node + edges
    Note right of DB: Door passable iff<br/>neighbour stability ≥ θ
    DB-->>W: Room + exits
    U->>W: Try a locked door
    W-->>U: Encounter = that card
    U->>W: Recall it correctly
    W->>API: POST /api/review/grade
    Note over API,DB: Same write path as Cards.<br/>Door unlocks.
```

### 3.4 The five loops

The surfaces in §3.1 are places. These are the loops a person runs through them. A comprehensive product has all five.

| Loop        | Timescale                            | What happens                                                | Requirements        | State                                                     |
| ----------- | ------------------------------------ | ----------------------------------------------------------- | ------------------- | --------------------------------------------------------- |
| **Capture** | Seconds                              | A link, a deck, a note or something learned at work goes in | §8.1, §8.2, HRV-10  | Anki import and URL harvest built. Pasted notes not built |
| **Distill** | Minutes                              | A source becomes a few small cards, with help               | CRD-10, AI-8, HRV-8 | Editor in the tree (ROADMAP CRD-A). Suggestions not built |
| **Recall**  | 5 minutes a day                      | Review what is due                                          | §8.3                | Built                                                     |
| **Explore** | 10 to 20 minutes, a few times a week | Move through the map. Recall opens doors                    | §8.4                | Core loop built. Not playtested (ROADMAP QST-A)           |
| **Apply**   | Weekly                               | Use it: explain it, build with it, answer a harder question | None yet (Q10)      | Not designed                                              |

Capture, Distill and Apply are the work side. Recall and Explore are the play side. Both sides write to one memory model (§3.2).

---

## 4. Problem & Motivation

Knowledge accumulates in places that don't talk to each other: Anki decks, browser bookmarks, read-later queues, class notes, the things you learn at work and never write down. Each is a write-only pile.

Three failures compound:

1. **Capture has no triage.** 3,861 bookmarks sit in `articles.csv`. Saving a link costs two seconds and buys nothing; the decision about _what it was for_ never happens. BMX's job is to make that decision automatically and be right often enough to be trusted.
2. **No connective tissue.** A card about `kin selection` and a bookmarked piece on green-hydrogen policy both touch incentive design; nothing in the stack knows that. The value of a corpus is in its edges, and no consumer tool builds them.
3. **Review is a chore.** Anki's retention curve is genuinely good, but the loop is joyless. Adherence is the binding constraint on spaced repetition — a scheduler you abandon has an effective retention of zero. Until v3 this document set no requirement that measured adherence. [§8.6](#86-measures) now does.

Remediate addresses (1) with BMX, (2) with an AI-built graph, and (3) by making traversal of that graph the reward loop.

---

## 5. Users & Jobs To Be Done

| User                              | Job                                                                                    | Success looks like                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Primary — the owner**           | "I have 457 Anki cards and 3,861 bookmarks. Get them into one system I actually open." | Decks import losslessly; bookmarks self-triage; review is at least as good as Anki.              |
| **Primary — the owner**           | "Keep feeding it: CompSci class notes, things I learn as a full-stack engineer."       | Paste URLs or notes; they land in the right deck without manual filing.                          |
| **Primary — the owner**           | "Show this to someone evaluating me technically."                                      | The repo reads as deliberate: typed end to end, tested, secure by construction, deployed, cheap. |
| **Secondary — a curious visitor** | "Play someone else's knowledge as a game."                                             | Uploads a bookmark export, gets a playable map in <2 min, on a phone, no account.                |
| **Tertiary — an agent**           | "Push knowledge into Remediate programmatically."                                      | Documented, authenticated, rate-limited ingest endpoint.                                         |

**Order.** These users are served in the order of the stages in [§1.1](#11-thesis-and-stages). The visitor and the agent belong to stage 2 and later. Login today is an email allowlist with a shared password, which is enough for stage 1 and not for stage 2 (Q9).

---

## 6. The Corpus (ground truth)

Measured, not estimated. Every number below came from parsing the actual files in `source_data/`, and each one changed a design decision.

| Source                                    | Raw lines | **True records** | Notes                                                    |
| ----------------------------------------- | --------: | ---------------: | -------------------------------------------------------- |
| `Anthro (Psych_Soc_Econ_Health).txt`      |     4,053 |          **320** | Real Anki export                                         |
| `CompSci (AIML_Web3_Math_Logic_Tech).txt` |       576 |          **137** | Real Anki export                                         |
| `anki_cards.csv`                          |       213 |              212 | **Lossy derivative** of Anthro. Not the source of truth. |
| `articles.csv`                            |     3,862 |        **3,861** | Bookmark metadata                                        |

**Findings that drive requirements:**

1. **Line-based parsing destroys the data.** 4,629 raw lines contain 457 records. 23 CompSci records carry embedded newlines inside quoted fields. A naive `split('\n')` then `split('\t')` yields ~90% garbage rows — and it fails _silently_, producing plausible-looking junk (`<div>` as a notetype). → [ING-2](#81-ingest--anki)
2. **Anki GUIDs exist and are stable.** All 457 are unique, zero collisions. This is a better identity than a content hash: it survives edits, so re-importing an edited deck updates instead of duplicating. v1 of this doc recommended content-hashing because it only looked at the CSV, which has no GUID column. → [ING-3](#81-ingest--anki)
3. **GUIDs are hostile strings.** The alphabet is base91: ``!#$%&()*+,-./:;<=>?@[]^_`{|}~`` plus alphanumerics. Real examples: `tNcJ[p<DNp`, `LKmX%^wX6E`, ``eATLwgRPX` ``. A GUID contains `<` and `&` (breaks HTML if unescaped) and `/`, `?`, `#`, `%` (breaks URL paths). → [ING-4](#81-ingest--anki), [SEC-1](#10-security-requirements)
4. **Fields are enormous.** Longest `Back` is **47,952 characters**. p95 is 6k (Anthro) / 11k (CompSci). One card is ~12k tokens — enrichment and embedding must chunk or truncate, and a naive "embed the whole field" blows the context budget. → [AI-2](#85-ai-enrichment)
5. **Content is real HTML with links.** `#html:true`, 27 `<a href="https://en.wikipedia.org/...">` in CompSci alone. Escaping renders every card broken; sanitizing is the only option, and the allowlist must include `<a>` with a protocol check. → [SEC-1](#10-security-requirements)
6. **Deck names contain `/`.** `CompSci (AIML/Web3/Math/Logic/Tech)`. Anki's hierarchy separator is `::`. Splitting on `/` shatters 2 decks into ~10 bogus ones. → [CRD-6](#83-cards--the-anki-surface)
7. **~45% of bookmarks won't yield full text.** Top domains: WSJ 759, **apple.news 643**, LA Times 458, Bloomberg 367, Wired 362, Business Insider 336, The Atlantic 326, Politico 188. WSJ/Bloomberg/Atlantic are hard-paywalled; `apple.news` links are opaque JS redirects that server-side fetch cannot resolve. A naive fetch-and-extract pipeline fails on roughly half the corpus. → [HRV-3](#82-harvest--bmx-bookmark-pipeline), the tiered-extraction requirement

> **The good news on (7):** `articles.csv` already carries `title`, `description`, `author`, and `date` for all 3,861. So the metadata is _already harvested_ — the pipeline degrades to metadata-only enrichment rather than failing. A paywalled Bloomberg piece still gets a title, a description, an embedding, and a graph position. Just at lower fidelity, and marked as such.

---

## 7. Scope

### 7.1 In scope for the prototype (P0)

Ordered by build sequence. **Cards ships before Quest.** _As built:_ every row below except P0-8 has shipped, in part or whole. P0-11 is deployed with a CSP, and whether the `remediate.app` domain is attached is unverified. [ROADMAP.md](./ROADMAP.md) has the detail.

| #     | Requirement                                                                     | Phase |
| ----- | ------------------------------------------------------------------------------- | ----- |
| P0-1  | Rename to Remediate; delete Neo4j/GraphQL/prod-Docker cruft                     | 0     |
| P0-2  | Import real Anki `.txt` exports (RFC4180 TSV, GUID identity, multi-line fields) | 2     |
| P0-3  | HTML sanitization at ingest, allowlist-based, `<a>` protocol-checked            | 2     |
| P0-4  | **Cards: FSRS-6 scheduling + review UI**                                        | 3     |
| P0-5  | Deck + tag browsing, card CRUD, stats                                           | 3     |
| P0-6  | **BMX: paste URLs → SSRF-guarded fetch → tiered extract → LLM triage → slot**   | 4     |
| P0-7  | BMX triage review queue (confirm / re-deck / discard)                           | 4     |
| P0-8  | AI enrichment: embeddings, concepts, `similar_to` + `prereq_of` edges           | 5     |
| P0-9  | Quest: graph-as-map, recall-gated doors, mobile-first                           | 6     |
| P0-10 | Auth + per-user isolation enforced at the DB (RLS)                              | 1     |
| P0-11 | Deployed to `remediate.app` with a strict CSP                                   | 7     |

### 7.2 Fast-follow (P1)

- `.apkg` (SQLite-in-zip) import.
- Export back to Anki-importable TSV with GUIDs preserved (round-trip fidelity).
- Cloze deletion note type. _(Today's corpus is 100% `Basic` — this is genuinely not needed yet.)_
- `apple.news` resolution via a headless fetch or the Apple News API.
- Reader-mode / archive.org fallback for paywalled domains.
- Media (images/audio) via Vercel Blob.
- LLM-generated Quest narration.
- MCP server so Claude Code can push/query Remediate directly.
- Public share links for a Quest map.
- Offline review as an outbox: cache the day's queue, record grades on the device, replay them on reconnect. Grades are already idempotent on the server. See [TDD §9.3](./TDD.md#93-offline-as-an-outbox-not-built). _(From the separate Anki PWA design, which ends here.)_
- Shareable deck links. _(Also from the Anki PWA design. This is the stage 2 on-ramp.)_
- Quest mechanics that build on the gate, each waiting on the QST-A playtest: territory that dims when its cards fall due, a streak with one forgiven day a week, a codex of retained concepts, a weekly seeded expedition. See [TDD §9.2](./TDD.md#92-candidate-mechanics-not-built).

### 7.3 Explicitly out of scope

- **AnkiWeb sync protocol.** Reverse-engineering it is a project unto itself.
- **Paywall circumvention.** Tiered extraction degrades gracefully; it does not bypass. This is both a legal and an ethical line, and it's not negotiable.
- **Collaborative/multiplayer editing.**
- **A native mobile app.** PWA suffices; "enjoyable on a phone" is a responsive requirement.
- **Training a local model.** `source_data/README.md` mentions a 30M-parameter goal. Frontier APIs beat it on every axis. Removed.
- **Neo4j.** See [TDD §3.2](./TDD.md#32-why-not-neo4j).
- **A local-first database with sync.** The Anki PWA design used one (Dexie plus Supabase). Remediate grades on the server inside a transaction, and a second store would need a sync design this project does not have. The outbox in §7.2 is the offline plan.

---

## 8. Feature Requirements

### 8.1 Ingest — Anki

| ID        | Requirement                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ING-1** | Accept real Anki exports (`.txt`/`.tsv`) and the legacy `.csv`. Honour the `#separator:`, `#html:`, `#guid column:`, `#notetype column:`, `#deck column:`, `#tags column:` preamble; use it to map columns rather than assuming positions.                                                                                                                    |
| **ING-2** | **Parse with a real RFC4180 parser** configured `delimiter=\t, quote=", escape=""`, multi-line fields enabled. Never `split('\n')`. Ground truth: 4,629 lines → 457 records.                                                                                                                                                                                  |
| **ING-3** | **Identity = Anki GUID** when the export declares `#guid column:`. Fall back to `sha256(deck‖front‖back)[:16]` only for the legacy CSV. Re-import is idempotent: same GUID ⇒ update, never duplicate. _As built:_ the content-id fallback is `contentId(userId, deck, front, back)` and applies to any export without a GUID column, not only the legacy CSV. |
| **ING-4** | GUIDs are base91 and contain HTML- and URL-hostile characters. Store the GUID as a unique column; derive a URL-safe internal ID (_As built:_ `digest(userId‖guid)` in `identity.ts`, owner-scoped so two importers of one shared deck do not collide) for routes and DOM ids. Never interpolate a raw GUID into markup or a path.                             |
| **ING-5** | Tags are **space-separated within one column** (`dataflow fullstack webdev`). Split on whitespace, not commas.                                                                                                                                                                                                                                                |
| **ING-6** | Sanitize every HTML field with an allowlist. Store sanitized only.                                                                                                                                                                                                                                                                                            |
| **ING-7** | Reject > 25 MB / > 100k records at the edge. Stream-parse. _As built:_ a 4 MB cap, under Vercel’s 4.5 MB request limit, read whole.                                                                                                                                                                                                                           |
| **ING-8** | Return `202` + job ID. Enrichment is out of the request path. _As built:_ import is a synchronous form action, and the real corpus fits in one request.                                                                                                                                                                                                       |
| **ING-9** | Preserve `notetype` per note. Today all 457 are `Basic`; the column exists so P1 cloze support doesn't need a migration.                                                                                                                                                                                                                                      |

### 8.2 Harvest — BMX bookmark pipeline

> This is the project's original vision and a P0 pipeline, not a nice-to-have.

| ID        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HRV-1** | Accept: pasted URL list (newline/comma separated), Netscape bookmark HTML export, and the `articles.csv` shape (`id,date,url,title,description,image,author`).                                                                                                                                                                                                                                                                                                          |
| **HRV-2** | Fetch is **SSRF-guarded**: resolve DNS first, reject private/link-local/loopback/metadata ranges, cap redirects at 3 and re-check every hop, cap body at 5 MB, 10s timeout.                                                                                                                                                                                                                                                                                             |
| **HRV-3** | **Tiered extraction — this is the core of the design**, given that ~45% of the real corpus is unreachable: <br/>• **Tier 1 `full`** — readability/trafilatura extracts main content. <br/>• **Tier 2 `metadata`** — paywalled/blocked/JS-redirect: use `<meta>` OG tags, or the pre-harvested `title`/`description` from `articles.csv`. <br/>• **Tier 3 `failed`** — record the URL and the reason; never silently drop. <br/>Every node stores its `extraction_tier`. |
| **HRV-4** | **LLM triage:** given extracted content, return `{summary, concepts[], proposed_deck, proposed_tags[], confidence}` via structured outputs. Deck/tag proposals must be constrained to the user's _existing_ decks and tags plus an explicit `"__new__"` escape — an unconstrained model invents a new taxonomy on every run.                                                                                                                                            |
| **HRV-5** | **Auto-slot at `confidence ≥ 0.7`; queue for human review below.** Tier-2 (metadata-only) extractions cap at `confidence ≤ 0.6`, so they always get a human look. _As built:_ deferred. No model call is built, so every harvest waits for a human decision.                                                                                                                                                                                                            |
| **HRV-6** | Triage review queue UI: batch confirm, re-deck, re-tag, discard. Keyboard-driven. This is the human-in-the-loop that makes auto-slotting trustworthy.                                                                                                                                                                                                                                                                                                                   |
| **HRV-7** | Deduplicate on normalized URL (strip `utm_*`, fragments, trailing slash) **and** on content hash — the corpus contains the same story via both `apple.news` and the publisher's own domain.                                                                                                                                                                                                                                                                             |
| **HRV-8** | A harvested doc becomes a reviewable card only when the user promotes it (or accepts an LLM-proposed Q/A pair). Harvesting ≠ enrolling 3,861 items into your review queue. _As built:_ accepting a harvest creates a card with review state (`kind='card'`), which this requirement forbids. ROADMAP BMX-A holds the decision (Q7).                                                                                                                                     |
| **HRV-9** | Respect `robots.txt`; identify with a real User-Agent; rate-limit per domain (≥1s). 759 requests to WSJ in a burst is abuse.                                                                                                                                                                                                                                                                                                                                            |

**HRV-10** (v3, not built). Accept pasted text as a source, the same way as a URL. It becomes a source document that cards are made from. This closes the "class notes" box in §3.1.

### 8.3 Cards — the Anki surface

> **Built first** (Phase 3), before Quest. It is a shippable product alone.

| ID        | Requirement                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRD-1** | FSRS-6 via `ts-fsrs`. Store full state: stability, difficulty, due, reps, lapses, state, last_review.                                         |
| **CRD-2** | Four-button grade with **projected next interval shown on each button** before committing. This is the Anki behaviour clones most often miss. |
| **CRD-3** | Queue respects due date + per-deck daily new/review limits.                                                                                   |
| **CRD-4** | Keyboard-first: `Space` reveal, `1–4` grade, `E` edit, `U` undo.                                                                              |
| **CRD-5** | Undo last review (one level).                                                                                                                 |
| **CRD-6** | Deck browsing. Anki's hierarchy separator is `::`, **not** `/`. Both real deck names contain `/`; treat them as flat.                         |
| **CRD-7** | Render sanitized HTML faithfully — `<a>` links open in a new tab with `rel="noopener noreferrer"`.                                            |
| **CRD-8** | Long fields (up to 48k chars) must not break layout: scroll within the card, don't overflow the page.                                         |
| **CRD-9** | Stats: retention rate, reviews/day heatmap, due forecast.                                                                                     |

**CRD-10** (v3, not built). **A card tests one thing.** Flag any answer over 1,200 characters for splitting into a source plus small cards (AI-8). The corpus has answers of 48,000 characters (§6 finding 4), and a five-second grade on one of those is not an honest grade.

### 8.4 Quest — the game surface

| ID        | Requirement                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **QST-1** | The map _is_ the graph. No hand-authored levels. Room = node; exits = edges.                                                             |
| **QST-2** | **Doors are recall-gated.** Edge passable iff neighbour's FSRS `stability ≥ θ`. A locked door triggers an encounter — which is the card. |
| **QST-3** | Grading in Quest calls the _same_ `POST /api/review/grade` as Cards. Exactly one review write path exists in the system.                 |
| **QST-4** | Position, visited set, run state persist server-side.                                                                                    |
| **QST-5** | Mobile-first: thumb-reachable, ≥44px targets, 360px width, no horizontal scroll.                                                         |
| **QST-6** | Anonymous play: upload a bookmark file → session-scoped ephemeral graph, no account, 24h TTL, node-capped, **no LLM access**.            |
| **QST-7** | Room text templated from node content in P0. LLM narration is P1 — see [TDD §7.3](./TDD.md#73-prompt-injection-is-the-real-ai-risk).     |

### 8.5 AI enrichment

| ID       | Requirement                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AI-1** | A current Claude model, chosen when ROADMAP AI-A starts (this draft named `claude-opus-4-8`, since superseded). Bulk work via Batch API (−50%) with prompt caching on the frozen system prefix (~0.1× on cached tokens). |
| **AI-2** | **Chunk before embedding.** Fields reach 48k chars (~12k tokens). Embed the first ~2k tokens plus the AI summary; do not embed raw 48k blobs.                                                                            |
| **AI-3** | Per node: 1-sentence summary, 3–7 concepts, difficulty 1–5. Structured outputs only — never free-text parsing.                                                                                                           |
| **AI-4** | `similar_to` edges at cosine ≥ 0.82, capped at 8/node. A cap is what keeps the map traversable rather than a hairball.                                                                                                   |
| **AI-5** | `prereq_of` edges between concepts. These give Quest's map a _gradient_ — without direction it's a flat mesh and every room looks alike.                                                                                 |
| **AI-6** | **All corpus content is untrusted.** Passed as delimited data in the user turn, never in the system prompt, never with side-effecting tools available.                                                                   |
| **AI-7** | Hard per-user token budget checked before dispatch. An AI endpoint without a budget is a billing DoS.                                                                                                                    |
| **AI-8** | Propose splits for oversized cards (CRD-10) as structured output: a source summary plus one to three single-fact cards. The owner accepts each card. AI-6 applies. _v3, not built._                                      |

### 8.6 Measures

> Added in v3. §4 names adherence as the binding constraint. These requirements measure it. None is built. All of them read `review_log` and the harvest tables and need no new dependency ([TDD §8.1](./TDD.md#81-measures-from-review_log-not-built)).

| ID        | Measure            | Definition                                                                        | Stage 1 target                         |
| --------- | ------------------ | --------------------------------------------------------------------------------- | -------------------------------------- |
| **MSR-1** | Days active        | Days in the last 28 with at least one grade                                       | ≥ 20                                   |
| **MSR-2** | Retained knowledge | Cards whose predicted recall today is ≥ 90%                                       | Rises week over week                   |
| **MSR-3** | Session shape      | Median session length, and the share of sessions that end at the end of the queue | 5 to 15 minutes. Most end on their own |
| **MSR-4** | Play share         | Share of grades with `surface = 'quest'`                                          | ≥ 30%                                  |
| **MSR-5** | Capture to card    | Share of accepted harvests that yield a card within 7 days                        | Set after the first reading            |
| **MSR-6** | One page           | The owner reads all five on one page, on a phone                                  | Shipped before any AI epic starts      |

The targets are first guesses. Revise them after four weeks of readings and record the change here.

---

## 9. Non-Functional Requirements

| Axis                      | Target                                                                      | Why                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Review latency**        | grade → next < 100ms p95                                                    | Anki desktop is instant. This forces the hot path to one indexed write + one indexed read — no AI, no fan-out. |
| **Quest room transition** | < 200ms p95                                                                 | Games feel broken above this.                                                                                  |
| **Anki import**           | 457 cards < 5s; 10k < 30s                                                   | 20× headroom on the real corpus.                                                                               |
| **BMX harvest**           | ≥ 1 URL/s sustained, per-domain ≥1s spacing                                 | Cold path; throughput over latency. HRV-9.                                                                     |
| **Mobile**                | Lighthouse ≥ 90 perf/a11y, LCP < 2.0s on 4G                                 | QST-5 is a hard requirement, so measure it.                                                                    |
| **Hosting cost**          | < $5/mo at personal scale                                                   | See §11.                                                                                                       |
| **Type safety**           | Zero `any` in `src/lib/server`; `strict: true`                              | The compiler should be doing the work.                                                                         |
| **Test coverage**         | 100% on the TSV parser, the sanitizer, the FSRS wrapper, and the SSRF guard | The four places where bugs are silent and expensive. Coverage elsewhere is negotiable.                         |
| **Adherence**             | ≥ 20 active days in 28 at stage 1 (MSR-1)                                   | A scheduler nobody opens has an effective retention of zero (§4).                                              |

_As built:_ the two latency targets have never been measured. ROADMAP OBS-A adds the timing.

---

## 10. Security Requirements

> Mechanisms in [TDD §7](./TDD.md#7-security-architecture). Four of these threats are present in the data in this repo _today_.

| ID        | Requirement                                                                                                                                                                        | Grounded in                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **SEC-1** | Imported HTML must never execute. Allowlist sanitize at ingest + strict CSP with nonces. `<a href>` restricted to `http/https/mailto`. GUIDs escaped before any markup or URL use. | 27 live `<a href>` in CompSci; GUIDs contain `<` and `&`.                                                           |
| **SEC-2** | **SSRF guard on all BMX fetches**: post-DNS-resolution IP check, redirect re-validation, no metadata/private ranges.                                                               | BMX fetches arbitrary user-supplied URLs. This is the single highest-severity new surface the harvester introduces. |
| **SEC-3** | CSV/TSV export must neutralize formula injection (`= + - @`, tab, CR prefixes).                                                                                                    | Round-trip export is P1 and a classic vector.                                                                       |
| **SEC-4** | Untrusted content structurally isolated from LLM instructions. No side-effecting tools in enrichment or triage.                                                                    | Bookmarked pages are attacker-authored by definition.                                                               |
| **SEC-5** | Tenant isolation at the database (RLS), not only app code.                                                                                                                         | One forgotten `where` from a full breach.                                                                           |
| **SEC-6** | Rate limits + per-user token budgets on every AI endpoint; per-domain politeness on fetch.                                                                                         | Cost DoS; and 759 rapid requests to WSJ is abuse.                                                                   |
| **SEC-7** | Argon2id passwords; passkeys preferred. Cookies `HttpOnly; Secure; SameSite=Lax`. Origin-checked mutations.                                                                        | Baseline.                                                                                                           |
| **SEC-8** | Remove `X-XSS-Protection` from `vercel.json`. _As built:_ done.                                                                                                                    | Deprecated; its filter has itself been an XSS vector. Shipping it beside a real CSP signals cargo-culting.          |
| **SEC-9** | Zip-bomb / decompression limits when `.apkg` lands (P1).                                                                                                                           | Deferred with the feature.                                                                                          |

_As built:_ SEC-7 is deferred. Login is an email allowlist plus a shared password, and an address is refused after 5 failed attempts in 15 minutes (ROADMAP SEC-A).

---

## 11. Cost Model

Target: **under $5/month** at personal scale.

| Line item            | Choice                           | Cost                           | Notes                                                                                                                                           |
| -------------------- | -------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting              | Vercel Hobby → Pro               | $0 → $20                       | Fluid compute bills active CPU, not I/O wait — AI calls and fetches are nearly free.                                                            |
| Database             | Neon Postgres                    | $0                             | Free tier 0.5 GB, scales to zero. Corpus is ~15 MB of text.                                                                                     |
| Vector               | pgvector (in Neon)               | $0                             | No separate store. [TDD §3.3](./TDD.md#33-why-not-a-dedicated-vector-db).                                                                       |
| **Anki enrichment**  | `claude-opus-4-8`, Batch         | **≈ $3.43 one-time**           | 457 cards, chunked to ~2k tok in / 200 tok out ≈ 914k in / 91k out. At $5/$25 per MTok, halved by Batch: ≈ $2.29 + $1.14…                       |
|                      |                                  |                                | At Opus 4.8 prices. Recompute for the model AI-A picks. Chunking (AI-2) is what keeps it here instead of ~$15 on raw 48k-char fields.           |
| **BMX triage**       | `claude-opus-4-8`, Batch, tiered | **~$8 one-time** for all 3,861 | Tier-2 (metadata-only, ~45%) costs ~⅕ of Tier-1 — the paywall constraint is accidentally a cost saving. Harvest incrementally, not all at once. |
| Quest narration (P1) | cached prefix                    | ~$0.50/mo                      |                                                                                                                                                 |
| **Steady state**     |                                  | **≈ $0–1/mo**                  | One-time backfill ≈ $12.                                                                                                                        |

_As built:_ no AI spend has occurred. The two one-time rows are estimates at July 2026 prices for a model since superseded. Recompute them when ROADMAP AI-A picks a model.

The cost story is a _design_ outcome: scale-to-zero Postgres, no always-on container, no second service, batch + cache + chunk on the AI path.

---

## 12. Success Criteria

v2 ticked all nine build criteria. A tick did not say who checked or how, and three of the nine depend on work that has not shipped. v3 gives each one a status and its basis. **Met** means ROADMAP records it as shipped. It was not re-run for this revision. **Unverified** means it may be true and nobody has measured it. **Not met** means the work it depends on is not built.

### 12.1 Build criteria

| #   | Criterion                                                                                                                                                                       | Status          | Basis                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | Both `.txt` exports import cleanly — **457 cards** (320 + 137), 2 decks, tags intact, 23 multi-line records intact, zero HTML artifacts rendered as text, zero script execution | Met             | Import, parser and sanitizer shipped                                                        |
| 2   | Re-importing the same file changes nothing (GUID idempotency)                                                                                                                   | Met             | Shipped with the importer                                                                   |
| 3   | A full review session runs on a phone; grade → next < 100ms p95                                                                                                                 | Unverified      | The session runs. The latency has never been measured (ROADMAP OBS-A)                       |
| 4   | **BMX: paste 20 mixed URLs (incl. a WSJ paywall and an `apple.news` link) → all 20 land in the graph**, tiered correctly, none silently dropped, low-confidence ones queued     | Not met in part | Tiered harvest shipped. No triage model runs, so there is no confidence to queue on (HRV-5) |
| 5   | Quest renders a navigable map with ≥1 AI-derived `prereq_of` edge a human agrees with                                                                                           | Not met         | The map renders from decks and tags. No AI edge exists (ROADMAP AI-A)                       |
| 6   | **A locked door opens because a card was recalled.**                                                                                                                            | Met             | Quest core loop shipped                                                                     |
| 7   | Deployed at `remediate.app`. Strict CSP. `securityheaders.com` grade A                                                                                                          | Unverified      | Deployed with a CSP. Domain attachment and the grade are unchecked (§7.1, ROADMAP OPS-1)    |
| 8   | CI green: typecheck, lint, unit, e2e                                                                                                                                            | Met             | CI runs on every PR                                                                         |
| 9   | `git clone` → running locally in < 5 min from the README alone                                                                                                                  | Unverified      | Nobody has timed it from a clean machine                                                    |

### 12.2 Product criteria

Added in v3. These are the criteria the thesis in [§1.1](#11-thesis-and-stages) stands on.

| #   | Criterion                                                                             | Status  | Basis                           |
| --- | ------------------------------------------------------------------------------------- | ------- | ------------------------------- |
| 10  | The phone playtest is recorded: three things that confused, three that worked         | Not met | Not run (ROADMAP QST-A)         |
| 11  | Stage 1 passes: MSR-1 ≥ 20 of 28 days, held for 8 consecutive weeks                   | Not met | MSR-6 is not built. No readings |
| 12  | Quest carries its weight: MSR-4 ≥ 30% over the same 8 weeks                           | Not met | Same                            |
| 13  | Stage 2 passes: one other person imports a deck and returns in week 2 without a nudge | Not met | Stage 1 comes first             |

### 12.3 Kill criteria

A thesis needs a way to be wrong.

- After 8 weeks of honest use, MSR-1 is below 12 of 28. The daily loop fails for its own author. Fix Recall before anything else.
- After the playtest and one round of changes, MSR-4 is below 10%. Quest is a demo, not a product. Keep Cards, park Quest, and say so in the README.
- No second person returns in week 2 after three tries with three people. Remediate stays a personal tool, and work on QST-6 and stage 3 stops.

---

## 13. Open Questions

| #   | Question                                                     | Owner            | Blocks       | Default if unanswered                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------ | ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Anonymous Quest play (QST-6) in P0, or auth-only?            | Human            | Quest scope  | **Ship it.** It's the demo path.                                                                                                                                                                                                         |
| Q2  | Is the `stability ≥ θ` door gate satisfying or punishing?    | Human (playtest) | QST-2 tuning | Start `θ = 1.0` (one successful recall); tune after playtest.                                                                                                                                                                            |
| Q3  | ~~Keep Python?~~                                             | —                | —            | **Resolved: no.** Extraction shipped in TypeScript. [TDD §3.1](./TDD.md#31-python-the-honest-answer) keeps the argument.                                                                                                                 |
| Q4  | ~~Is the graph dense enough to be interesting?~~             | —                | —            | **Largely resolved.** 457 cards + 3,861 bookmarks ≈ 4,300 nodes today, growing with class notes and work knowledge. Risk downgraded High → Medium ([TDD R1](./TDD.md#11-risks)); the B3 gate stays because _density_ ≠ _meaningfulness_. |
| Q5  | Auto-slot threshold at 0.7 — too eager, or not eager enough? | Human            | HRV-5 tuning | Start 0.7. If the review queue is mostly rubber-stamping, raise it; if you're undoing auto-slots, lower it.                                                                                                                              |
| Q6  | Promote harvested docs to cards automatically?               | Human            | HRV-8        | **No.** 3,861 auto-enrolled cards would destroy the review queue. Promotion stays manual until there's a reason.                                                                                                                         |
| Q7  | What does a harvested bookmark become in the graph?          | Human            | HRV-8, AI-A  | ROADMAP BMX-A lists three options. A `doc` node with no review state is the one that matches §3.2 and HRV-8.                                                                                                                             |
| Q8  | How are oversized cards split, and who approves?             | Human            | CRD-10, AI-8 | A model proposes and the owner accepts each card. No bulk split. Split one deck by hand first to learn what a good split looks like.                                                                                                     |
| Q9  | What accounts does stage 2 need?                             | Human            | Stage 2      | Keep the shared password until stage 1 passes.                                                                                                                                                                                           |
| Q10 | What is the Apply loop (§3.4)?                               | Human            | None yet     | Leave it undesigned until stage 1 passes.                                                                                                                                                                                                |
