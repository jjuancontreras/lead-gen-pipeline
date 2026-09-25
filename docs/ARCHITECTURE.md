# Architecture

The pipeline finds Metro Manila small businesses that have no website, and
helps you turn them into clients. Machines prepare; you craft:

- **Automated:** discovery, verification, first-contact drafts, scheduling,
  bookkeeping.
- **Yours:** choosing who gets a demo, designing it (`/demo-site-build`),
  triggering its recording, and pressing Send.

Nothing is ever sent automatically, and nothing is ever deployed
automatically. [WORKFLOW.md](WORKFLOW.md) is the day-to-day guide; this file
covers how it is built.

| Entry point | What it does |
|---|---|
| `npm run campaign` | **Discovery**: source, verify, enrich, then Tier-1 outreach drafts. Makes live calls to Overpass, Google Maps, Bing and Gemini. |
| `npm run console` → `/queue` | **Work Queue**: every lead waiting on you, grouped by what you owe it, with a button for each next step. |
| `npm run console` → `/` | **Lead inbox**: browse and filter every lead; draw areas; launch campaigns. |
| `worklist`, `sent`, `draft`, `new-demo`, `harvest`, `record`, `mockup`, `publish` | The same operations from the command line. |

## Data model

`src/lead.ts` defines `Lead`, a flat record of 40 string columns. Column order
is the Google Sheet's column order. The **`status` column is the only
workflow state**: resumable, idempotent, and editable by hand in the Sheet.

```
sourced → shortlisted → verified ─┬─ (tier B) drafted → tier1_sent ──┐
            └→ needs_manual       └─ (tier A, you choose)            ├→ replied → meeting → won | lost
                                     demo_queued → scaffolded →      │
                                     demo_built → demo_sent ─────────┘
```

Any active lead can go to `nurture` or `disqualified`.

- **One rulebook for moves.** `src/transitions.ts` says which move is legal
  from which status, what it writes (for example, `pitch_sent` starts the
  3/7/14 clock via `sentPatch`), and that an opted-out lead can be closed out
  but never moved toward contact.
- **Opt-outs.** `do_not_contact` (any non-empty value) suppresses every
  outreach path (`isSuppressed`). RA 10173 applies.

### Stores (`src/store.ts`, `src/store-sheets.ts`)

- **`SheetsStore`.** Google Sheets through `spreadsheets.values`. The header row
  is asserted by position before any write. This is production data.
- **`JsonStore`.** `<data dir>/leads.json`, written with write-then-rename.

`openStore()` picks Sheets when `GOOGLE_SHEET_ID` and `GOOGLE_SA_KEY_PATH` are
set, unless `PIPELINE_STORE=json`. The tests always use JSON in a temporary
directory.

## Discovery campaign (`bin/campaign.ts`, `src/stages/`)

| Stage | Reads | Does | Writes | External calls |
|---|---|---|---|---|
| source | `config/areas.json`, `categories.json`, `chain-index.json` | Overpass query for the area, then an SME filter that drops chains and out-of-band categories (`src/sme.ts`) | new leads, `sourced` | Overpass (retries, mirror failover, 240 s timeout) |
| verify | `sourced`/`shortlisted` | Resolves each lead on Google Maps in headless Chromium, classifies its website (`src/website.ts`), assigns a tier (`src/score.ts`) | `website_*`, `tier`, `verified`/`needs_manual`/`disqualified` | Google Maps (paced 12 s, one retry) |
| enrich | `verified` with no email | Reads the business's own Facebook or Instagram page, then a Bing search, for contact handles (`src/social.ts`) | `email`, `instagram`, `facebook`, `tiktok` | Facebook, Instagram, Bing (paced 8 s) |
| outreach | `verified` tier B, due follow-ups | Renders first-contact or follow-up copy (`src/outreach.ts`, `templates/outreach/`) | draft files in `<data dir>/drafts/`, `drafted` | Gmail drafts API (only with a working token) |

There is deliberately no scaffold stage. A demo is 3–5 hours of your time,
so choosing which leads get one is a Work Queue decision.

## Work Queue (`src/work-queue.ts`, `src/queue-routes.ts`, `console/queue.html`)

`workQueue(leads, {today, area})` is pure. It groups leads by the action they
are waiting on:

- `verify`: `needs_manual`, `shortlisted`
- `choose`: `verified` tier A
- `build`: `demo_queued`, `scaffolded`
- `record`: `demo_built` with no video
- `pitch`: `demo_built` with a video link
- `send`: `drafted`
- `followup`: due `tier1_sent` or `demo_sent`
- `conversations`: everything else still live

Suppressed and closed leads are left out. `queue-view.ts` adds what each card
needs: search links, whether a recording exists, and whether a pitch can be
drafted.

| Route | Does | Reuses |
|---|---|---|
| `GET /api/queue?area=` | the grouped queue, job status, setup warnings | `work-queue.ts`, `queue-view.ts` |
| `POST /api/queue/transition` | a status move | `transitions.ts` |
| `POST /api/queue/verify` | a hand verification | `manual-verify.ts` (shared with `worklist --ingest`) |
| `POST /api/queue/build` | scaffold, or adopt an existing folder | `demo-kit.ts` → `scaffoldDemo` |
| `POST /api/queue/pitch` | write the Tier-2 pitch draft | `pitch-draft.ts` → `renderTemplate('email-demo')` + `draftFileBody` |
| `POST /api/queue/record` *(job)* | film the live demo: 16:9 + 9:16 + hero PNG into `<slug>/public/demo/` | `demo-kit.ts` → `recordDemo`, `generateMockup` |
| `POST /api/queue/harvest` *(job)* | Instagram photos into the demo's `research/` | `harvestAssets` |
| `POST /api/queue/verify-run` *(job)* | automatic verify, next 40 in the area | `verifyLeads` |
| `GET /demo-files/<slug>/public/demo/*` | a recording, for preview (only `.mp4`/`.png` under `public/demo`) | `static-server.ts` |

Background jobs run one at a time (`src/single-job.ts`) and under a
cross-process lock file (`src/run-lock.ts`), so the CLI and the console never
interleave writes. The page polls while a job runs.

### Console security (`src/http.ts` `requestRefusal`)

The console binds to `127.0.0.1` with no login, which keeps other machines
out but not other web pages. Every request must carry our own `Host` header,
which defeats DNS rebinding. `/api/` refuses cross-site `Sec-Fetch-Site` and
foreign `Origin` headers. POST bodies must be `application/json`. File routes
are path-contained (`resolveStatic`).

## Services

| Service | Used by | In tests |
|---|---|---|
| Overpass API | source | fixtures |
| Google Maps (Playwright) | verify, Verify next 40 | never called |
| Facebook / Instagram / Bing | enrich, harvest | never called |
| Gemini | harvest curation, menu OCR | never called |
| Google Sheets | store | JSON store in a temp dir |
| Gmail drafts | outreach | never called; drafts go to files |
| Chromium, ffmpeg, ffprobe | Record, mockup, e2e | local |
| Vercel | `npm run publish` only, which you run yourself | never called |

## Configuration (`src/settings.ts`)

Every environment setting is read once and validated with zod. A bad value
fails at startup and names the setting. A blank value means unset.
`.env.local` is loaded first; real environment variables win.

| Setting | Default | Meaning |
|---|---|---|
| `DEMO_SITES_ROOT` | the repo's parent folder | Where hand-built demos and `.claude/launch.json` live. **Set it**: the default is wrong since the repo moved out of OneDrive |
| `SENDER_EMAIL`, `SENDER_NAME` | none / name in `SENDER` | Signs the Tier-2 pitch. Pitch drafts refuse without an email |
| `PORTFOLIO_URLS` | none | Live demos linked from first-contact emails (an optional `{{?portfolio_line}}`) |
| `PIPELINE_VIDEO_MS` | `27000` | Target Record length |
| `SEND_EMAILS` | `false` | Must stay `false`; `true` is refused. Nothing in the codebase sends |
| `PIPELINE_DATA_DIR`, `PIPELINE_STORE` | `./data`, `auto` | Where the JSON store and drafts live; `json` keeps off the Sheet |
| `CONSOLE_PORT` | `3008` | `0` picks a free port (the tests use this) |
| `LOG_FORMAT`, `LOG_LEVEL` | `pretty`, `info` | Structured logger (`src/log.ts`) |

`npm run doctor` reports all of them.

## Tests

| Command | Covers |
|---|---|
| `npm test` | Unit and integration: transitions, the queue, hand verification, the demo kit (a real scaffold into a temp root), pitch drafts, settings, the request guard, the run lock, plus the discovery and outreach suites |
| `npm run e2e` | Playwright against the real console, on a seeded JSON store and a temp demos folder. It walks choose → Build demo → Mark built → Record (real recorder and ffmpeg) → set video → Draft pitch → Mark pitch sent, plus verify, send, conversations, every page state, the API's refusals, the request guard, phone width, keyboard, axe and zero console errors |
| `npm run check` | lint, typecheck, test, build, e2e |
