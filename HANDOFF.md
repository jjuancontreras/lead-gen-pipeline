# Client Acquisition Pipeline — Session Handoff

**Read this first in a new session.** Verified against disk as of **2026-09-23** (overnight
autonomous review session — see §0). Repo root is now
`C:\Users\xdevi\dev\tools\pipeline\` — **moved out of OneDrive** since the last handoff (the
2026-09-03 version of this file still said `OneDrive\Desktop\Websites\pipeline\`; that path is
stale). `.claude/launch.json` no longer exists at a Websites root either — there is none in this
repo, and none is required for `npm run console` or a direct `tsx bin/console.ts` invocation.

---

## 0. This session — what was verified, what changed, what to look at

Ran unattended overnight per your instruction to analyze, test and improve the pipeline
end-to-end. Summary, most important first:

**The codebase is in noticeably better shape than the last handoff suggests.** Commit `298c5cd`
(2026-09-04, "sent-confirmation flow, redesigned console, code-quality pass") already shipped the
§6 task from the old handoff (copy-pasteable, fenced-field drafts with a Gmail compose link) plus
a full console redesign, a `drafted` status + `npm run sent` confirmation flow, and a proper 3/7/14
follow-up cadence (`src/cadence.ts`). None of that was reflected in the old HANDOFF.md.

**Verified, not just read:**
- `npx tsc --noEmit` — clean.
- `npx tsx --test "test/**/*.test.ts"` — **321/321 passing** (was 257 as of the last handoff).
- `npm run doctor` — all green except the Gmail token, which is *supposed* to be unusable right
  now (you deferred it; outreach correctly degrades to `data/drafts/*.md`). Sheets store connects
  live: 997 leads, breakdown in the doctor output.
- `templates/demo-site/` — copied to a scratch dir (never touched the shipped template),
  `npm install && npm run build && npm run lint` — clean build, clean lint, zero errors. The
  template still ships depless in the repo.
- `npm run console` — started for real against the live Sheet, driven through the browser: area
  switching, all 8 pipeline-stage filters, tier/presence/sort filters, opening a lead's detail
  panel (signals, reasons, contact channels), the drafted-message view (To/Subject/Body fenced
  fields with copy buttons + "Open in Gmail"), and the "Areas & campaigns" map/run panel. No
  console errors, no failed requests, no dead ends. **I did not click "Mark as sent" or run a
  non-dry-run campaign** — those mutate the live Sheet and are exactly the actions you said nobody
  should trigger by accident.
- `npm run campaign -- --area katipunan --dry-run` — ran for real, **all five stages, start to
  finish**, against production data, writing nothing (dry-run, exit code 0). This is the
  strongest evidence in this whole session that the pipeline works end-to-end right now:
  - `source`: 919 named → 664 in SME band (matches the old handoff's Katipunan numbers almost
    exactly).
  - `verify`: 40/40 attempted, 25 resolved automatically (tiers A:2 B:6 C:13), 15 correctly
    routed to `needs_manual` (ambiguous Maps matches, no-match, consent walls) — real Playwright
    lookups against live Google Maps, ~1 lead/90s.
  - `enrich`: correctly found the 2 leads still missing an email and tried their own pages/a Bing
    search for each; found nothing this time (real result — no bug, just no public contact on
    those two).
  - `scaffold`: correctly picked the one A-tier lead awaiting a demo shell and would have
    scaffolded it (`gubat`, dry run).
  - `outreach`: correctly picked up **6 real leads from a September Katipunan run** (names withheld) as due for the `breakup-14` follow-up — proof the 3/7/14 cadence math in
    `src/cadence.ts` correctly reads real, weeks-old `first_contacted_at` timestamps from the
    live Sheet and picks the right step. Dry run, so nothing was drafted or written.
  - Full log, if useful:
    `C:\Users\xdevi\AppData\Local\Temp\pipeline-campaign-dryrun.log` (from this session; may be
    cleared by routine temp-directory cleanup, not preserved long-term).

**Code review, not just tests:** read every console frontend module (`console/js/*.js`,
`console/console.css`), `bin/console.ts`, and the newest backend modules (`src/stages/outreach.ts`,
`src/draft-file.ts`, `src/cadence.ts`, `src/stages/{source,verify,scaffold}.ts`). All of it is
careful, already-tested, security-conscious code (header-injection guards on the Gmail MIME
builder, markdown-injection escaping in draft files, path-traversal guards in the console's static
file server, a documented cyclic-import decision, focus-trapping in the modal, an OSM
query-retry). **I did not find a real backend bug.** I did not do a wholesale UI rewrite for the
same reason — see §0a.

**One item flagged, not fixed — needs your call:** `npm audit` reports a **HIGH severity**
vulnerability in `sharp@0.34.5` (inherited libvips/libheif CVEs — the advisory covers
CVE-2026-33327/33328/35590/35591 and two libheif GHSAs). `sharp` is what `src/harvest.ts` and
`src/mockup.ts` use for every photo you curate and every mockup PNG. `npm audit fix --force`
would bump it to `0.35.4`, which npm itself labels a breaking change. I did not run it: a
breaking image-library upgrade needs a real photo run to confirm mockups and harvested images
still look right, and that's not something to gamble on unattended against production leads.
Run `npm audit fix --force` yourself, then `npm run mockup -- --slug <any existing demo slug>`
and eyeball the output before trusting it again.

**Two small, verified fixes applied, both zero-risk:**
- [`package.json`](package.json) — the `console` script passed a dead `--port 3067` flag that
  `bin/console.ts` never reads (the port is hardcoded to `3008`, matching what SETUP.md
  documents). Removed the dead flag.
- Attempted and **reverted** a cleanup of `config/chains-manual.json` — see §0b, worth reading
  before anyone tries this again.

### 0a. On "the UI is a bit too cluttered"

I tested the console live against real data (screenshots, keyboard nav, the ops sheet, mobile
width) looking specifically for this. What's there now is the *already-redesigned* console from
`298c5cd` — dense, but deliberately so: a documented one-hue-per-meaning color system, real
`aria-*` wiring, a skip link, reduced-motion handling, and a toolbar that collapses at three
breakpoints (1240px hides keyboard hints, 1040px docks the detail rail as a slide-over, 820px
drops the score/contact columns). I could not find a concrete clutter problem to fix without
guessing — and guessing meant either leaving something you actually meant, or doing an
unrequested redesign of code that already works and that you can't review until morning. I left it
alone rather than risk that trade.

If "cluttered" is about something specific — too many controls in the toolbar row, the ops sheet
holding both area-drawing and campaign-running in one panel, information density in the table —
tell me which one and I'll go straight at it instead of re-guessing.

### 0b. A cautionary tale, for whoever reads this next

The old handoff's §10 listed "QA findings #11 (dead denylist entries)" as a deferred cleanup.
`config/chains-manual.json` documents itself as "deliberately MINIMAL... anything the index
already catches is removed on purpose." I cross-referenced the manual denylist against the
generated `chain-index.json` counts and found `"army navy"` (36 locations) and `"pancake house"`
(57 locations) both present in the index at well above the cutoff of 5 — looked redundant, so I
removed them.

**`npx tsx --test` immediately caught it**: `test/chain-index.test.ts` failed on `'Army Navy
Burger' should still be caught by the denylist`. The reason is in `src/sme.ts`'s
`isManualChain()` — `chainLocations()` does an *exact* normalized-name lookup against the index,
but the manual list does bounded prefix/suffix matching for name **variants** ("Army Navy Burger"
extends "army navy" by one real word that `normalizeName` does not strip, since "burger" is not a
location or branch token). The base name being in the index does not mean every real-world
variant of it is. I reverted both removals immediately; `git diff config/chains-manual.json` is
clean. Test suite back to 321/321.

Lesson for both of us: that QA-findings list in the old handoff had no supporting detail, and at
least one item on it (findings #6 garbage `website_url`, #10 bbox validation, and the 3 "LOW
outreach findings" are the others) may be similarly stale or already fixed rather than actionable
as written. `isValidBbox()` already exists in `bin/console.ts:52` with real range/ordering
checks, for what it's worth — #10 may already be done. I did not chase #6 or the LOW findings
tonight; there's no detail on file anywhere (no `QA.md`, nothing in git history past this handoff)
to act on without re-deriving the audit from scratch, which is a real task, not an overnight
guess.

### 0c. Structural refactor (later on 2026-09-23, after the thermo-nuclear review)

A strict maintainability review found structural debt the line-level read had missed. Fixes
applied, all verified (`tsc` clean, **342/342** tests, live read-only console + dry-run checks):

- **Bug fixed — dates were UTC.** `today()` was `toISOString().slice(0,10)`, which is *yesterday*
  in Manila before 08:00: a morning run recorded the wrong `first_contacted_at` and missed
  follow-ups due that day. Now `src/dates.ts` (Asia/Manila), the only date helper.
- **Outreach rules in one place.** `src/outreach-policy.ts` (eligibility, `selectPool`,
  `templateFor`) is shared by the stage and the console; `/api/draft` logic moved out of the HTTP
  server into `src/draft-view.ts` (now tested); `/api/sent` uses `sentRefusal()` from
  `src/mark-sent.ts` instead of hand-copied guards.
- **No more fake stage registry.** `consumes`, `requires` and `maxGeminiCalls` were declared but
  never read; stages registered themselves by side-effect import. Now `STAGES` in
  `src/stages/index.ts` is a plain ordered array. Scaffold passes its brief note via
  `StageResult.briefNotes` instead of the orchestrator string-matching its summary.
- **Sheet writes batched.** `LeadStore.updateMany()` = one read + one `values.batchUpdate`.
  Used by `worklist`, `npm run sent` and the outreach stage (was a full-sheet read per lead —
  60 in a burst for `worklist`, right at the 60-reads/minute quota). Verify/enrich keep
  per-lead writes on purpose. **Not yet exercised against the live Sheet** — the pure planning is
  unit-tested and the call shape matches googleapis, but the first real `npm run sent` or
  `worklist` run is its first live use. Watch that run.
- **Dedupes:** `slugify` → `src/normalize.ts`; browser identity → `src/browser-identity.ts`;
  argv parsing → `src/cli-args.ts` (also fixes `build-chain-index --phase` reading the wrong arg);
  a test now keeps `console/js/vocabulary.js` statuses in sync with `src/lead.ts`.

**Still open, needs your decision (review finding #3):** the `notes` column holds both
machine-written scoring reasons and your hand-typed notes. Verify overwrites it (your notes on an
unverified lead are lost on the next run), and the console colours reasons by regex-matching the
English text `score.ts` writes. Full fix = a separate `score_reasons` Sheet column (schema change
to the live Sheet); lighter fix = no schema change, stop the overwrite, move the tone classifier
next to the phrases in `score.ts`.

---

## 1. Business context

Jfer Contreras — 4th-year Management Information Systems student, Ateneo de Manila.
Freelance web design for Metro Manila SMEs (Katipunan / QC focus).

| | |
|---|---|
| Capacity | 3–5 clients/month |
| Price | ₱5,000–7,000 per site |
| Maintenance | ₱1,000/month (the real business — compounds toward ~₱48k/mo MRR in a year) |
| Deployment | I handle it; client pays only for a custom domain |
| Target | **SMEs only** — no Jollibee/KFC scale, no international brands, no large fast-food |
| Tools | Claude Pro, Google Workspace, Gemini API free tier. **No credit card on Google Cloud.** |

**The definition that drives the whole funnel:** a Facebook / Instagram / TikTok / Linktree
presence is **not** a website. A lead whose only "site" is a Facebook page is the *best*
prospect (tier A), not a disqualification. Only a separate standalone site disqualifies.

**Contact priority order, always:** email → phone → Instagram → Facebook → TikTok.

### Two-tier funnel
4 closes/month needs ~70–110 first touches. A full demo per lead is impossible.

| | Volume | Work | Deliverable |
|---|---|---|---|
| Tier 1 | ~50–60/mo | ~10 min | Personalized message + portfolio links + hero mockup PNG |
| Tier 2 | ~8–12/mo | 3–5 hrs | Full demo site + recorded walkthrough |

---

## 2. Hard constraints (do not violate)

- **Nothing is ever sent automatically.** Email → Gmail *drafts* **or** `data/drafts/*.md` files
  only. Instagram / Facebook / Messenger / TikTok → render to a file for manual paste; Meta bans
  accounts for DM automation. There is deliberately **no send path anywhere in the codebase.**
- **`do_not_contact` / `isSuppressed(lead)` (in `src/lead.ts`) must be checked before every
  outreach rendering path** (RA 10173, PH Data Privacy Act — identify yourself, include an
  opt-out). Enforced in `selectPool`, in the console's `/api/draft`, and in `withdrawSuppressedDrafts`
  (which tombstones any draft already on disk for a lead flagged after the draft was written).
- **The LIVE lead store is the Google Sheet**, not `data/leads.json`.
  `GOOGLE_SHEET_ID = 1sbZcbOm675ep1xatsKFJ3kcxv5O9iNClgK3BC4sCPWc`, `GOOGLE_SA_KEY_PATH` set in
  `.env.local`, both credential files at `C:\Users\xdevi\.secrets\` (outside OneDrive and the
  repo, confirmed again this session). `openStore()` in `src/store.ts` returns `SheetsStore` when
  both env vars are set, else `JsonStore(dataPath('leads.json'))`. **`data/leads.json` is a STALE
  local export — never trust it for lead state.** Inspect real state via `openStore()` /
  `npm run doctor`. **997 real businesses as of tonight.** Never mutate casually.
- Free-tier Gemini content trains Google's models → **public business data only**. Never client
  contracts, pricing, or inbox contents. Those stay in Claude Code.
- **Gemini free tier has NO Grounding with Google Search.** It cannot browse. Playwright fetches,
  Gemini reads, Claude Code decides.
- Scraping Google Maps is against Google's ToS. `VERIFY_PROVIDER` env switch exists so the
  sanctioned Places API path is a one-line swap.
- Don't scrape real Instagram profiles during testing — IP block risk.
- **Model policy:** main thread = higher model; subagents = **≤3**, each with an explicit
  `model` — **Sonnet** for judgement, **Haiku** for fully-specified mechanical work. Every
  `Agent` call passes an explicit `model`. Use subagents to keep the main context lean.

---

## 3. Architecture

Node 24 + TypeScript ESM, run via `tsx`. Explicit `.ts` import extensions. Tests are
`node:test` + `node:assert/strict` (**no vitest**), run with `tsx --test "test/**/*.test.ts"`.
**As of 2026-09-23 (after §0c): 342 tests passing, `tsc --noEmit` clean.**

```
pipeline/
  .env.local              GEMINI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SA_KEY_PATH,
                          GOOGLE_SHEET_TAB, GMAIL_TOKEN_PATH   (gitignored)
  config/                 areas.json (katipunan, shaw-blvd-mandaluyong),
                          categories.json, chain-index.json (GENERATED, ~21 days old
                          as of tonight — SETUP.md says rebuild past 90 days),
                          chains-manual.json (see §0b before touching), social-domains.json
  src/
    campaign-stages.ts    Stage / StageResult / Caps contract (no registry - see stages/index.ts)
    gmail-creds.ts        loadGmailCreds + gmailCredsUsable() + gmailReady() (never throw)
    dates.ts              today() in Asia/Manila, addDays, daysBetween - the only date helper
    outreach-policy.ts    pure: who is due (selectPool), which template (templateFor)
    draft-view.ts         what the console shows for one lead's message (draft/preview/none)
    browser-identity.ts   one user agent + Playwright context options, shared
    cli-args.ts           args / val() for every bin/ script
    build-prompt.ts       writeBuildPrompt(): BUILD-PROMPT-<Business>.md generator
    draft-file.ts         NEW since last handoff — fenced-field draft rendering,
                          the Gmail compose deep link, withdrawal tombstones, the
                          drafts INDEX.md builder. Read this before touching outreach copy.
    cadence.ts             NEW — the 3/7/14 follow-up sequence as pure date arithmetic
    mark-sent.ts           NEW — sentPatch(): what `npm run sent` / the console's
                          "Mark as sent" button writes once a human confirms a send
    config.ts env.ts      config loading; env.ts loads .env.local once
    lead.ts               Lead type + STATUSES (sourced..drafted..tier1_sent..won/lost/
                          nurture/disqualified/needs_manual) + isSuppressed()
    store.ts               openStore() -> SheetsStore | JsonStore
    overpass.ts fetcher.ts gemini.ts  OSM query / Playwright fetch / Gemini calls
    sme.ts score.ts normalize.ts website.ts social.ts  filtering + classification
    harvest.ts            IG grid scrape -> sharp optimise
    scaffold.ts           copies templates/demo-site -> new folder, allocates port,
                          seeds content.json, writes BUILD-PROMPT
    mockup.ts record.ts   Tier-1 PNG; Tier-2 Playwright screencast -> ffmpeg MP4
    outreach.ts           template rendering (renderer; never sends)
    providers/            browser.ts | places.ts behind one interface
    stages/               source, verify, enrich, scaffold, outreach; index.ts = STAGES, in order
  bin/                    campaign console doctor build-chain-index source-area
                          verify-leads worklist new-demo draft-outreach harvest-assets
                          record publish mockup mark-sent sample-palette.py
  console/                redesigned console (298c5cd): index.html + console.css +
                          js/{app,state,dom,data,inbox,detail-panel,campaign,vocabulary,
                          format,toast}.js. Well-factored — see §0 before rewriting any of it.
  templates/demo-site/    Next.js 16.3.x + Turbopack; ships WITHOUT node_modules;
                          neutral-grey PLACEHOLDER palette; content.json skeleton.
                          Build + lint verified clean tonight from a scratch copy.
  templates/outreach/     9 templates: email-first, instagram-dm, messenger-dm,
                          follow-up-{3,7}, breakup-14, ...
  apps-script/digest.gs   daily 08:00 Sheet-bound follow-up digest (runs with PC off)
```

### The one design idea that matters

**The `status` column IS the state machine.** `campaign` runs the `STAGES` array in order; each
stage reads the store, picks the leads whose status it acts on, and writes the next status back.
Stages hold no state of their own. Resume is free, runs are idempotent, and it's hand-drivable
(edit a status cell and the next run honours it).

Stage order: `source → verify → enrich → scaffold → outreach`.

```
sourced → shortlisted → verified → scaffolded → drafted → tier1_sent → replied
        → demo_built → demo_sent → meeting → won | lost | nurture | disqualified
```
Plus `needs_manual`. `INACTIVE = {won, lost, nurture, disqualified}`.
`drafted` is new since the last handoff: writing a draft file no longer starts the 3/7/14 clock by
itself — only `npm run sent` (a human confirming the message actually went out) does, via
`src/mark-sent.ts`. This closed the gap where the follow-up sequence could run against a business
that never actually heard from you.

### Rails
`DEFAULT_CAPS = { maxFetches: 60, maxScaffolds: 3, maxVerify: 40 }` (`maxFetches` is enrich's
page-load budget).
`--dry-run` writes nothing. `--stage <name>` runs one stage. Verify's actual pace is
**12s** between leads (`src/stages/verify.ts` `paceMs ?? 12_000`), not the "3-5s jittered" the
old handoff claimed — confirmed by timing tonight's real dry run. Ports: demos allocate from
**3011 up** via `withLaunchLock` (exclusive-create lock, 10s timeout).

### Chain detection is *generated*, not hand-written
`bin/build-chain-index.ts` runs one wide Metro Manila Overpass query, normalizes names, writes
`name → location_count`. Cutoff is 5; **2–4 branches is a bonus, not a penalty**
(`content.json` has a `branches` key). The manual denylist (`config/chains-manual.json`) is a
**separate, non-redundant** mechanism for name variants the index's exact-match lookup misses —
see §0b before pruning it again.

---

## 4. Live run state — Google Sheet, as of tonight's `npm run doctor`

```
store: sheets - 997 leads
needs_manual 28, nurture 18, tier1_sent 6, verified 7, demo_built 2,
disqualified 10, sourced 917, scaffolded 3, drafted 6
```

Areas configured: `katipunan`, `shaw-blvd-mandaluyong`. A real campaign has run against both
(6 drafted-and-not-yet-marked-sent leads sit in `data/drafts/` from a Shaw Blvd run: Cheech &
Chang Hong Kong Roasts, Daddy Doogie's Kitchen, Silantro Fil-Mex Cantina, Nine Spices Hotpot &
Grill, Espresso Studio, Tiny Tavern — `data/drafts/INDEX.md` lists them with checkboxes).

**Nothing was sent, marked sent, or written to the Sheet this session.** Every verification above
used `--dry-run`, read-only console browsing, or a scratch copy of the template outside the repo.

---

## 5. What was FIXED in the 298c5cd session (superseding the old §5/§6)

Everything the 2026-09-03 handoff's §6 asked for ("make `data/drafts/*.md` easily
copy-and-pasteable") is done, plus more:

| Item | Where |
|---|---|
| Fenced To/Subject/Body fields, each with its own copy button | `src/draft-file.ts` `field()` / `draftFileBody()` |
| A Gmail compose deep-link per email draft (opens prefilled, still requires pressing Send) | `src/draft-file.ts` `gmailComposeLink()` |
| `drafted` status — writing a file no longer starts the follow-up clock | `src/lead.ts`, `src/stages/outreach.ts` |
| `npm run sent` / console "Mark as sent" — the only thing that starts the clock | `src/mark-sent.ts`, `bin/mark-sent.ts`, `bin/console.ts` `/api/sent` |
| 3/7/14 follow-up cadence reachable from a template-less `npm run campaign` | `src/cadence.ts`, `selectPool()` in `src/stages/outreach.ts` |
| A suppressed lead's existing draft is tombstoned, not left sendable | `withdrawSuppressedDrafts()` |
| Console redesigned: 14 raw statuses collapsed to 8 task-oriented views, area/campaign scope selector, live draft preview in the detail panel | `console/` (all of it) |
| `/api/draft` and `/api/sent` share one eligibility predicate with `selectPool` instead of a hand-kept duplicate | `isOpeningEligible` / `isFollowUpDue` (now in `src/outreach-policy.ts`, §0c) |
| Credential JSONs moved outside OneDrive/repo | confirmed again tonight, §2 |

---

## 6. CURRENT TASK — none queued

The one open decision is review finding #3 (§0c): new `score_reasons` column, or the lighter
no-schema fix. Other candidates:

- Chase the old QA list's remaining items (#6 garbage `website_url`, the 3 LOW outreach findings)
  for real, which means re-running that audit — there's no surviving detail to act on blindly
  (§0b).
- Point me at whatever "cluttered" meant specifically (§0a) and I'll fix that directly.
- The Gmail token, whenever you're ready (§8) — still your call, still deferred.

---

## 7. Full `git status --porcelain` (pipeline repo, at the start of tonight's session)

```
 M config/areas.json
?? data/campaign-brief-shaw-blvd-mandaluyong-2026-09-03.md
?? data/drafts/INDEX.md
?? data/drafts/cheech-chang-hong-kong-roasts.md
?? data/drafts/daddy-doogies-kitchen.md
?? data/drafts/espresso-studio.md
?? data/drafts/nine-spices-hotpot-grill.md
?? data/drafts/silantro-fil-mex-cantina.md
?? data/drafts/tiny-tavern.md
```

This session added on top of that (both trivial, both verified safe — see §0):
```
 M package.json     dead `--port 3067` flag removed from the `console` script
 M HANDOFF.md        this file
```

Nothing was committed. When asked, commit messages end with
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; PR descriptions end with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## 8. Gmail token — the deferred fix (still your call)

`.env.local` `GMAIL_TOKEN_PATH` still points at the OAuth **client** file, which has no
`refresh_token`. `gmailCredsUsable()` correctly reports it unusable; outreach correctly degrades
to `data/drafts/`. This is the intended state until you run the manual OAuth-playground flow in
`SETUP.md` Step 4. Nothing about this changed tonight, and I didn't touch it — you deferred it
explicitly in a previous session and that instruction stands.

---

## 9. Security

Both credential JSONs live at `C:\Users\xdevi\.secrets\` (outside OneDrive, outside the repo),
confirmed again this session via `.env.local`. `.gitignore` still carries `client_secret_*.json` /
`perfect-crow-*.json` as defense in depth. Nothing to do here unless you still want to rotate the
OAuth client secret / service-account key from when they briefly sat in the OneDrive-synced
folder (mentioned, never confirmed done, in the 2026-09-03 handoff).

---

## 10. Deferred / lower priority

- The Gmail token fix (§8) — your call.
- `bin/gmail-auth.ts` automated consent flow — still deferred in favor of the manual path.
- Re-automating the design pass — deliberately removed; `demo-site-build` skill stays manual.
- Importer to migrate any local JSON leads into the Google Sheet — probably moot now (997 leads
  already live in the Sheet).
- The old QA findings #6 / #10 / #11 and 3 LOW outreach findings — #11 is **not** actionable as
  written (§0b), #10 may already be done (`isValidBbox()` exists), #6 and the LOW findings have no
  surviving detail to act on.
- `RUNBOOK.md` — mentioned in the old handoff as "likely superseded"; still doesn't exist, and
  SETUP.md + this file cover daily use now.

---

## 11. Known environment gotchas (already paid for once)

- **Windows: no Docker / Postgres.** embedded-postgres, IPv6-only binding, `pnpm` allowBuilds,
  `NODE_ENV` pitfalls all apply.
- The repo no longer lives under OneDrive, so the old "heredocs are unreliable in the OneDrive
  path" gotcha no longer applies here — still true for anything still under
  `OneDrive\Desktop\Websites\`.
- Browser-pane `computer`/screenshot clicks time out when the pane isn't visibly shown — use
  `get_page_text` / `javascript_tool`. CSS transitions freeze mid-flight there
  (`getComputedStyle` returns stale interpolated values). media-gen MCP can be out of credits.
- `spawn npx ENOENT` on Windows → spawn `process.execPath` with the resolved `tsx/dist/cli.mjs`
  (this is exactly what `bin/console.ts` `/api/campaign` already does — copy that pattern, don't
  reintroduce `npx`).
- Recorder: `waitForSelector` needs `:not([hidden])` or it resolves to the Next.js dev overlay;
  `__name is not defined` needs `page.addInitScript`.
- `apps-script/*.gs` is plain JS — no TypeScript annotations; verify with `node --check`.
- Verify Vercel deploys with `curl -sI`, not the Browser pane (false `ERR_BLOCKED_BY_CLIENT`).
- `templates/demo-site/` build leaves a `package-lock.json` that trips Next's workspace-root
  inference — delete build artifacts after any template verification so it ships depless (or, as
  done tonight, build from a scratch copy outside the repo and never touch the shipped template
  at all).
- Overpass (`overpass-api.de`) genuinely returns a busy/timeout on attempt 1 sometimes — this is
  already handled (`runOverpass` retries once), confirmed live tonight, not a bug.

---

## 12. Related memory files

`C:\Users\xdevi\.claude\projects\C--Users-xdevi-OneDrive-Desktop-Websites\memory\` — **stale
path**, predates the move out of OneDrive. If a future session wants this project's memory
findable again, it should check whether Claude Code re-derived a
`C--Users-xdevi-dev-tools-pipeline` memory directory for the new path, and if not, consider
whether the old entries below are worth copying over:
- `pipeline-architecture-notes.md` — Sheets store, manual demo build, `scaffolded`, Gmail degradation.
- `demo-site-workflow-feedback.md` — don't visually clone sibling demos; scrape real photos, use the skills.
- `execute-web-development-process.md` — the user's name for the full demo-site build pipeline.
- `browser-tool-headless-quirks.md`, `windows-dev-environment-constraints.md`.
