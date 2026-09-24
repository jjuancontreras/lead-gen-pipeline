# Architecture

The pipeline finds Metro Manila small businesses that have no website, builds
each one a demo site, records a walkthrough video of it, and drafts a
personalized outreach email. It never sends anything, and it never deploys
anything.

There are two ways to drive it:

| Entry point | What it runs | Store |
|---|---|---|
| `npm run campaign` | The **discovery campaign**: source, verify, enrich, scaffold, outreach. Makes live calls to Overpass, Google Maps, Bing and Gemini. | The configured store (Google Sheet when credentials exist) |
| `npm run pipeline` | The **demo pipeline**: find, site, video, email. Tracks per-lead, per-stage status and can be resumed. | The configured store, or the JSON store under `PIPELINE_DATA_DIR` |

`npm run e2e` runs the demo pipeline against three fixture businesses in a
throwaway data directory, with no network calls.

## Data model

`src/lead.ts` defines `Lead`, a flat record of 40 string columns. Column order
is the Google Sheet's column order. The `status` column is the discovery
campaign's state machine:

```
sourced -> shortlisted -> verified -> scaffolded -> drafted -> tier1_sent -> replied
                  \-> needs_manual       demo_built -> demo_sent -> meeting -> won | lost
```

`do_not_contact` (any non-empty value) suppresses every outreach path
(`isSuppressed`). RA 10173 applies.

### Stores (`src/store.ts`, `src/store-sheets.ts`)

`LeadStore` has two implementations:

- `SheetsStore` - Google Sheets through `spreadsheets.values`. The header row is
  asserted by position before any write. Production data, 997 rows.
- `JsonStore` - `<data dir>/leads.json`, written with write-then-rename.

`openStore()` picks Sheets when `GOOGLE_SHEET_ID` and `GOOGLE_SA_KEY_PATH` are
set, unless `PIPELINE_STORE=json`. Tests and the e2e always use JSON in a
temporary directory.

### Stage state (`src/pipeline/state.ts`)

The demo pipeline records, per lead and per stage, one of
`pending | running | done | failed`, with the error message, the attempt
count, timestamps and the stage's validated output. It lives in
`<data dir>/pipeline-state.json`, not in the Sheet, so the production Sheet's
schema is unchanged.

## Discovery campaign (`bin/campaign.ts`, `src/stages/`)

| Stage | Reads | Does | Writes | External calls |
|---|---|---|---|---|
| source | `config/areas.json`, `categories.json`, `chain-index.json` | Overpass query for the area, then an SME filter that drops chains and categories outside the SME band (`src/sme.ts`) | new leads, status `sourced` | Overpass (retries, mirror failover, 240 s timeout) |
| verify | leads `sourced`/`shortlisted` | Resolves each lead on Google Maps in headless Chromium, classifies the website (`src/website.ts`), assigns a tier (`src/score.ts`) | `website_*`, `tier`, status `verified`/`needs_manual`/`disqualified` | Google Maps (paced 12 s, one retry) |
| enrich | `verified` leads with no email | Reads the business's own Facebook/Instagram page, then a Bing search, for contact handles (`src/social.ts`) | `email`, `instagram`, `facebook`, `tiktok` | Facebook, Instagram, Bing (paced 8 s) |
| scaffold | `verified` tier-A leads | Copies `templates/demo-site` (a Next.js app) to `<sites root>/<slug>`, seeds `content.json`, writes a BUILD-PROMPT, allocates a dev port in `launch.json` | `demo_slug`, status `scaffolded` | none |
| outreach | `verified` tier-B leads, due follow-ups | Renders first-contact or follow-up copy (`src/outreach.ts`, `templates/outreach/`) | draft files in `<data dir>/drafts/`, status `drafted` | Gmail drafts API (only with a working token) |

The campaign writes a brief (`<data dir>/campaign-brief-<area>-<date>.md`)
listing leads that need a person.

Other discovery-side commands: `worklist` (manual verification in a browser),
`sent` (a person confirms a send and the 3/7/14 follow-up clock starts),
`harvest` (Instagram photos with Gemini curation), `mockup` (a phone mockup
image), `record` (walkthrough video of a Next.js demo), and `publish` (Vercel
deploy; not run by any automated path).

## Demo pipeline (`bin/pipeline.ts`, `src/pipeline/`)

```
 leads (store or fixtures)
    |
    v
 [find]  validate the lead: a real business, no standalone website,
    |    not suppressed, enough detail to build a page      -> FoundLead
    v
 [site]  render a static, responsive site from the lead's own
    |    details into <data dir>/sites/<slug>/index.html      -> SiteArtifact
    v
 [video] serve the site on loopback, record a scrolled walkthrough
    |    in headless Chromium, transcode with ffmpeg, probe it -> VideoArtifact
    v
 [email] render the demo email (site link, video link, sender
         identity, opt-out line), write it to
         <data dir>/emails/<slug>.md; send only if SEND_EMAILS=true
         and a real mailer exists (none does)                 -> EmailDraft
```

Every hand-off is a zod schema in `src/pipeline/schemas.ts`. A stage's output
is parsed before it is stored, and the next stage parses its input again, so a
malformed artifact fails at the boundary where it was produced.

`src/pipeline/runner.ts` runs the stages:

- **Per-lead isolation.** Each lead runs each stage inside its own try/catch.
  A failure marks that lead's stage `failed` with the error and moves on. Later
  stages skip a lead whose earlier stage is not `done`.
- **Resumable and idempotent.** A stage that is `done`, and whose output file
  still exists, is skipped on the next run. A `running` entry left behind by a
  crash counts as `pending`. `--retry <lead>:<stage>` resets that stage and
  every later one.
- **Retries and timeouts.** External work goes through `withRetry` in
  `src/retry.ts`, which applies exponential backoff with jitter and a timeout
  on each attempt.

### Services

| Service | Used by | Real | In tests / e2e |
|---|---|---|---|
| Overpass API | source | `src/overpass.ts` | fixture JSON |
| Google Maps (Playwright) | verify | `src/fetcher.ts` | not called |
| Facebook / Instagram / Bing | enrich, harvest | `src/stages/enrich.ts`, `src/harvest.ts` | not called |
| Gemini | harvest, palette | `src/gemini.ts` | not called |
| Google Sheets | store | `src/store-sheets.ts` | JSON store in a temp dir |
| Gmail drafts | outreach | `src/stages/outreach.ts` | not called; drafts go to files |
| Chromium (Playwright) | video, site render check, dashboard tests | local | local |
| ffmpeg / ffprobe | video | local | local |
| Mail transport | email | none exists; `SEND_EMAILS` must stay `false` | a spy mailer that counts calls |

## Configuration (`src/settings.ts`)

Every environment setting is read once and validated with zod. A bad value
fails at startup with the name of the setting. `.env.local` is loaded first
(`src/env.ts`), and real environment variables take precedence.

| Setting | Default | Meaning |
|---|---|---|
| `PIPELINE_DATA_DIR` | `./data` | Leads (JSON store), drafts, sites, videos, emails, pipeline state |
| `PIPELINE_STORE` | `auto` | `auto` uses the Sheet when credentials exist; `json` forces the local store |
| `SEND_EMAILS` | `false` | Must be `false`. No transport is implemented, so `true` is refused |
| `SENDER_NAME`, `SENDER_EMAIL` | name from `SENDER`, no email | Sender identity in the email signature. The email stage fails without `SENDER_EMAIL` |
| `PUBLIC_BASE_URL` | `http://localhost:3008` | Prefix for the site and video links in emails |
| `DEMO_SITES_ROOT` | the repo's parent folder | Where scaffolded Next.js demos and `.claude/launch.json` live |
| `PIPELINE_VIDEO_MS` | `27000` | Target walkthrough length |
| `CONSOLE_PORT` | `3008` | Console port; `0` picks a free one (the dashboard tests use this) |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` / `info` | Structured logger (`src/log.ts`) |

A blank value (`PIPELINE_STORE=`) means unset. `npm run doctor` reports all of
them, and `test/settings.test.ts` checks that `.env.example`, copied as is, is
a valid configuration.

## Console (`bin/console.ts`, `console/`)

The console is a loopback-only HTTP server on port 3008 with an ES-module
frontend. It has these views:

- **Pipeline dashboard**: every lead's status in each of the four stages,
  a retry button for each failed stage, and previews of the site, video and
  email.
- **Lead inbox** and **campaign launcher**: discovery-side.

API:

| Route | Purpose |
|---|---|
| `GET /pipeline` | the dashboard page (`console/pipeline.html`, `console/js/pipeline*.js`, `console/dashboard.css`) |
| `GET /api/pipeline` | one row per lead with each stage's status, attempts and error; stage counts; job status; areas with how many leads are ready |
| `POST /api/pipeline/retry` | `{lead_id, stage}`: reset that stage and every later one, then rerun that lead in the background (202; 409 while a job runs) |
| `POST /api/pipeline/run` | `{area, limit}` (1-10): run the area's demo-ready leads in the background |
| `GET /sites/<slug>/`, `GET /videos/<slug>/<file>` | preview artifacts from the data directory, path-checked, with byte ranges for video |
| `GET /api/leads`, `/api/draft`, `POST /api/sent`, `/api/areas`, `/api/campaign` | discovery-side |

The email preview comes from the email stage's recorded output in
`/api/pipeline`, not from a file route. One job runs at a time
(`SingleJob` in `src/pipeline/dashboard.ts`), because two runs would each
read-modify-write the same state file.

## Tests

| Command | What it covers | Time |
|---|---|---|
| `npm test` | Unit and integration tests: every stage, each hand-off schema, the runner (isolation, resume, rebuild), the send gate, settings, the static server, the dashboard view model, plus the discovery campaign's existing suites | ~2 s |
| `npm run e2e` | The CLI takes the 3 fixture businesses through all four stages in a temp dir, offline; asserts sites render in Chromium, videos have real durations, drafts are complete, zero sent, and a rerun is a no-op | ~45 s |
| `npm run test:ui` | Playwright against the real console: states, retry, previews, validation, keyboard, phone width, axe, zero console errors | ~15 s |
| `npm run check` | lint, typecheck, test, build, e2e, test:ui, in that order | ~1.5 min |
