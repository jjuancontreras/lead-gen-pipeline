# Client Acquisition Pipeline — Session Handoff

**Read this first in a new session.** Verified against disk as of **2026-09-03**.
Repo root: `C:\Users\xdevi\OneDrive\Desktop\Websites\pipeline\` (its own git repo; sibling to the demo sites).
This file supersedes the 2026-09-02 handoff — the "3 open issues / implementation plan" in it is now **mostly implemented** (see §5–§7).

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
  opt-out). Already enforced in `selectPool`.
- **The LIVE lead store is the Google Sheet**, not `data/leads.json`.
  `GOOGLE_SHEET_ID = 1sbZcbOm675ep1xatsKFJ3kcxv5O9iNClgK3BC4sCPWc`, `GOOGLE_SA_KEY_PATH` set in
  `.env.local`. `openStore()` in `src/store.ts` returns `SheetsStore` when both env vars are set,
  else `JsonStore(dataPath('leads.json'))`. **`data/leads.json` is a STALE local export — never
  trust it for lead state.** Inspect real state via `openStore()` / `npm run doctor`.
  ~1,327 real businesses. Never mutate casually.
- Credential JSONs belong **outside OneDrive**, e.g. `C:\Users\xdevi\.secrets\`. **Currently
  VIOLATED** — see §9.
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
**As of this session: 257 tests passing, `tsc --noEmit` clean.**

```
pipeline/
  .env.local              GEMINI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SA_KEY_PATH,
                          GOOGLE_SHEET_TAB, GMAIL_TOKEN_PATH   (gitignored)
  config/                 areas.json, categories.json, chain-index.json (GENERATED),
                          chains-manual.json, social-domains.json
  src/
    campaign-stages.ts    stage registry + Caps + credentialAvailable()  (gmail gate now
                          checks gmailCredsUsable(), not just env-var presence)
    gmail-creds.ts        NEW — loadGmailCreds + gmailCredsUsable() (safe, never throws)
    build-prompt.ts       NEW — writeBuildPrompt(): BUILD-PROMPT-<Business>.md generator
    config.ts env.ts      config loading; env.ts loads .env.local once
    lead.ts               Lead type + STATUSES (now includes 'scaffolded') + INACTIVE
    store.ts              openStore() -> SheetsStore | JsonStore
    overpass.ts fetcher.ts gemini.ts  OSM query / Playwright fetch / Gemini calls
    sme.ts score.ts normalize.ts website.ts social.ts  filtering + classification
    harvest.ts            IG grid scrape -> sharp optimise
    scaffold.ts           copies templates/demo-site -> new folder, allocates port,
                          seeds content.json, writes BUILD-PROMPT
    mockup.ts record.ts   Tier-1 PNG; Tier-2 Playwright screencast -> ffmpeg MP4
    outreach.ts           template rendering (renderer; never sends)
    providers/            browser.ts | places.ts behind one interface
    stages/               source, verify, enrich, scaffold, outreach, index
  bin/                    campaign console doctor build-chain-index source-area
                          verify-leads worklist new-demo draft-outreach harvest-assets
                          record publish mockup sample-palette.py
  console/index.html      Leaflet area picker + SSE campaign stream + lead inbox
  templates/demo-site/    Next.js 16.3.4 + Turbopack; ships WITHOUT node_modules;
                          neutral-grey PLACEHOLDER palette; content.json skeleton
  templates/outreach/     9 templates: email-first, instagram-dm, messenger-dm,
                          follow-up-{3,7}, breakup-14, ...
  apps-script/digest.gs   daily 08:00 Sheet-bound follow-up digest (runs with PC off)
```

`.claude/launch.json` lives at the **Websites root** (`C:\Users\xdevi\OneDrive\Desktop\Websites\`),
**not** in `pipeline/`.

### The one design idea that matters

**The `status` column IS the state machine.** `campaign` is a dispatcher: each stage declares
which statuses it `consumes`, the orchestrator asks who's eligible and runs them in order.
Stages hold no state of their own. Resume is free, runs are idempotent, and it's hand-drivable
(edit a status cell and the next run honours it).

Stage order: `source → verify → enrich → scaffold → outreach`.

```
sourced → shortlisted → verified → scaffolded → tier1_sent → replied
        → demo_built → demo_sent → meeting → won | lost | nurture | disqualified
```
Plus `needs_manual`. `INACTIVE = {won, lost, nurture, disqualified}` — `scaffolded` is NOT inactive.

### Rails
`DEFAULT_CAPS = { maxFetches: 60, maxGeminiCalls: 200, maxScaffolds: 3, maxVerify: 40 }`.
`--dry-run` writes nothing. `--stage <name>` runs one stage. 3–5s jittered throttle on browser
fetches. Ports: demos allocate from **3011 up** via `withLaunchLock` (exclusive-create lock over
`.claude/launch.json`, 10s timeout).

### Chain detection is *generated*, not hand-written
`bin/build-chain-index.ts` runs one wide Metro Manila Overpass query, normalizes names, writes
`name → location_count`. 107 names with 5+ locations carry no `brand` tag. Cutoff is 5;
**2–4 branches is a bonus, not a penalty** (`content.json` has a `branches` key).

---

## 4. Live run state — Katipunan (Google Sheet)

The pipeline works end-to-end on real data. From the 2026-09-02 `npm run campaign --area katipunan`:
Source 920 named → 665 in SME band; Verify 22/40 → A:3, B:8, C:5; Enrich 8/10 gained a contact;
Scaffold `sicilian-roast` → 3013, `beanleaf-katipunan` → 3014. Brief:
`data/campaign-brief-katipunan-2026-09-02.md`.

**This session, an outreach run advanced 6 real Katipunan B-tier leads in the production Sheet**
(names withheld)
— `first_contacted_at` set, `status → tier1_sent`, drafts written to `data/drafts/*.md`. This was
sanctioned. A step-5 test mutation on "Pino" was reverted (`status: sourced, demo_slug: ""`).

---

## 5. What was FIXED (2026-09-02 → 2026-09-03) — the old "3 open issues" plan

The approved plan (Gmail hard-fail → graceful degradation; scaffold mislabel → `scaffolded`
status; automated demo → manual BUILD-PROMPT) is **implemented and verified**:

| Item | Status | Where |
|---|---|---|
| `src/gmail-creds.ts` — `loadGmailCreds` moved here + `gmailCredsUsable()` (never throws) | DONE | `src/gmail-creds.ts`; re-exported from `src/stages/outreach.ts` |
| Gmail credential gate checks *usability*, not just env-var presence | DONE | `src/campaign-stages.ts` `credentialAvailable('gmail')` |
| `bin/doctor.ts` reports a broken token honestly ("set but unusable (missing refresh_token) - outreach will write files to data/drafts/") | DONE | `bin/doctor.ts` (creds loop + "what will run" table) |
| Outreach degrades: no usable token → writes `data/drafts/*.md`, never throws | DONE + verified | `src/stages/outreach.ts` `draftOutreach()` |
| New `scaffolded` status between `verified` and delivery | DONE | `src/lead.ts` STATUSES; `console/index.html` front-end list |
| Scaffold stage writes `status: 'scaffolded'` (not `'demo_built'`) | DONE | `src/stages/scaffold.ts`, `bin/new-demo.ts` |
| Outreach still sees scaffolded leads | DONE | `outreach.ts` `consumes: ['verified','scaffolded']` + `selectPool` filter |
| `src/build-prompt.ts` — `writeBuildPrompt()` generates `BUILD-PROMPT-<Business>.md` (business facts, contacts, "assets to obtain" checklist, `/demo-site-build` invocation, "this is a placeholder shell" note, "when done" publish step) | DONE | `src/build-prompt.ts`, wired into `src/scaffold.ts` |
| Campaign brief references each BUILD-PROMPT; scaffold summary says "scaffolded (shell only) N of M" | DONE | `bin/campaign.ts`, `src/stages/scaffold.ts` |
| SETUP.md Step 4 — manual OAuth-playground runbook replaces the "ask me for a script" line | DONE | `SETUP.md` |
| `test/gmail-creds.test.ts` added; `test/outreach.test.ts` extended (scaffolded lead in pool) | DONE | 257 tests pass |
| Template: dead `/menu` `/locations` links → on-page `#menu` / `#branches` anchors | DONE (prior agent) | `templates/demo-site/src/app/page.tsx`, `src/components/Hero.tsx` |
| Template: `dish.image!` non-null assertion → guard (`dish.image ? <Image/> : <div className="bg-surface"/>`) | DONE (prior agent) | `page.tsx` |
| Template: unused `import Link from "next/link"` left behind → removed | DONE this session | `page.tsx` |
| Template: `AnimatedSection` didn't accept the `id` prop the page passes → added `id?: string` + `id={id}` on `<motion.section>` | DONE this session | `src/components/AnimatedSection.tsx` |
| **Template build actually verified** — `npm install` + `npm run build` in `templates/demo-site/` → `✓ Compiled successfully`, TS clean, static pages 3/3, exit 0. Artifacts (`node_modules`, `.next`, `package-lock.json`, `next-env.d.ts`, `tsconfig.tsbuildinfo`) then removed so the template still ships depless. | DONE this session | — |

**Demo-site build is now MANUAL.** Scaffold produces an honestly-labeled shell + `content.json`
skeleton + `research/` folders + `BUILD-PROMPT-<Business>.md`. Jfer opens that file in Claude Code
and runs the design build via the `demo-site-build` skill (research → palette-from-photos →
content → DESIGN.md → build/lint → parallel code+security review → Vercel deploy). No auto-design.
A lead becomes `demo_built` only after that manual build + `npm run publish -- --slug <slug>`.

---

## 6. CURRENT TASK — make `data/drafts/*.md` easily copy-and-pasteable (NOT STARTED)

> User, this session: *"for the gmail token just hold it off for now instead just create a
> system where it contains the emails draft that is easily copy and pastable — hold off on the
> gmail token part for now, I'll fix it another time."*

**Do NOT work on making the Gmail OAuth token functional — the user deferred it.** Instead improve
the file-based drafts so each Gmail-compose field is a one-tap copy.

**Current output** (`src/stages/outreach.ts`): `writeDraftFile()` writes one
`data/drafts/<slug>.md` per lead — a `# <name>` heading, a "**Nothing here has been sent.**" line,
metadata bullets (`lead`, `channel -> <destination>`, `template`, `rendered`), a `---` rule, then
for email a bare `Subject: <line>` immediately followed by the multi-paragraph body. The "To"
address is only in a metadata bullet. Nothing is structured for one-shot paste.

**The functions to change** (all in `src/stages/outreach.ts`):
- `draftFileBody(lead, channel, template, r): string` (~lines 140–160) — the body builder.
- `writeDraftFile(lead, channel, template, r): string` (~lines 162–167) — path + write.
- Keep `createGmailDraft()` intact (unused while token is broken, but leave the code path).

**Proposed shape** (confirm with user, then implement): for `channel === 'email'`, emit three
clearly-labeled, individually fenced code blocks — **To** (`destination(lead,'email')`),
**Subject** (`r.subject`), **Body** (`r.body`) — each a ```` ``` ```` block so markdown/terminal
renderers give a copy button per field. Keep the `# <name>`, the "Nothing here has been sent"
honesty line, and the metadata bullets as context above the rule. Social-channel drafts stay a
single copyable body block. Optionally add `data/drafts/INDEX.md` — one place listing every
pending draft (name, channel, destination, file link, status) with checkboxes.

Then: update `test/outreach.test.ts` assertions on `draftFileBody`, run `npx tsc --noEmit` +
`npm test` (keep ≥ 257, adjust for changed tests), and show the user a sample of the new format.
Bounded single-module change — main thread or **one** subagent with an explicit model.
**Do not commit unless asked.**

---

## 7. Full `git status --porcelain` (pipeline repo, uncommitted)

```
 M .env.example            pre-existing USER edit — DO NOT REVERT
 M package.json            pre-existing USER edit — DO NOT REVERT
 M SETUP.md                manual OAuth runbook (§5)
 M bin/campaign.ts         brief references BUILD-PROMPT
 M bin/doctor.ts           gmail-aware
 M bin/new-demo.ts         status: 'scaffolded'
 M console/index.html      scaffolded front-end status
 M src/campaign-stages.ts  credentialAvailable gmail usability gate
 M src/lead.ts             'scaffolded' in STATUSES
 M src/scaffold.ts         writeBuildPrompt wired in
 M src/stages/outreach.ts  consumes ['verified','scaffolded'], re-exports gmail-creds
 M src/stages/scaffold.ts  status scaffolded + "shell only" summary
 M test/outreach.test.ts   +1 scaffolded pool test
 M templates/demo-site/src/app/page.tsx                 dead-link + image guard + unused import
 M templates/demo-site/src/components/AnimatedSection.tsx  id prop
 M templates/demo-site/src/components/Hero.tsx          dead-link anchors
?? HANDOFF.md
?? src/build-prompt.ts
?? src/gmail-creds.ts
?? test/gmail-creds.test.ts
?? data/campaign-brief-katipunan-2026-09-02.md
?? data/drafts/
?? client_secret_137100221597-qgv683f4di51hed6v30g5iq4rvgosck0.apps.googleusercontent.com.json
?? perfect-crow-497106-g8-4736eeae951e.json
```

Nothing has been committed this session (user hasn't asked). When asked, commit messages end with
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; PR descriptions end with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## 8. Gmail token — the deferred fix (do NOT pursue now)

`.env.local` `GMAIL_TOKEN_PATH` points at the OAuth **client** file
(`client_secret_137100221597-…json`) — `{installed:{client_id, client_secret}}`, **no
refresh_token**. A refresh token only exists after a one-time user consent flow.
`gmailCredsUsable()` now correctly returns `false` for it, so outreach degrades to `data/drafts/`
— which is the intended state until the user fixes the token.

**Runbook (in `SETUP.md` Step 4, for when the user is ready):** enable Gmail API → OAuth consent
screen (External, self as Test user, scope `gmail.compose`) → https://developers.google.com/oauthplayground/
with own credentials → authorize `gmail.compose` → exchange for **refresh_token** → write
`C:\Users\xdevi\.secrets\gmail-token.json` as `{client_id, client_secret, refresh_token}` →
point `.env.local` at it → `npm run doctor` should report healthy.
`loadGmailCreds()` already accepts that flat shape — no code change needed for the happy path.

`bin/gmail-auth.ts` (automated loopback consent flow) is still **deferred** — user chose the
manual path.

---

## 9. Security TODO for the user (mentioned, not done)

Both credential JSONs currently sit **inside `pipeline/` inside OneDrive** (untracked but present):
- `client_secret_137100221597-qgv683f4di51hed6v30g5iq4rvgosck0.apps.googleusercontent.com.json` (OAuth client)
- `perfect-crow-497106-g8-4736eeae951e.json` (**Google service-account key — actively referenced
  by `.env.local` `GOOGLE_SA_KEY_PATH`**)

Move both to `C:\Users\xdevi\.secrets\` and update `.env.local`. They must not live in OneDrive
or the repo.

**Update (2026-09-03): done.** Both files now live at
`C:\Users\xdevi\.secrets\client_secret_137100221597-…json` and
`C:\Users\xdevi\.secrets\perfect-crow-497106-g8-4736eeae951e.json`. `.env.local`
`GOOGLE_SA_KEY_PATH` / `GMAIL_TOKEN_PATH` updated to match and verified with `npm run doctor`
(Sheet still connects, 665 leads). `.gitignore` also gained `client_secret_*.json` /
`perfect-crow-*.json` as defense in depth. Neither file was ever committed (`git log` confirms),
so no history rewrite is needed — but because they sat in a OneDrive-synced folder in plaintext,
the user should still consider rotating the OAuth client secret and the service-account key.

---

## 10. Deferred / lower priority

- The Gmail token fix (§8) — user: "I'll fix it another time."
- `bin/gmail-auth.ts` automated consent flow.
- Re-automating the design pass (deliberately removed).
- Importer to migrate any local JSON leads into the Google Sheet.
- QA findings #6 (garbage `website_url`), #10 (bbox validation), #11 (dead denylist entries),
  plus 3 LOW outreach findings.
- `RUNBOOK.md` — likely superseded now the pipeline has been run for real.

---

## 11. Known environment gotchas (already paid for once)

- **Windows: no Docker / Postgres.** embedded-postgres, IPv6-only binding, `pnpm` allowBuilds,
  `NODE_ENV` pitfalls all apply.
- Heredocs are unreliable in the OneDrive path — use the Write tool for temp `.mjs` scripts
  inside `pipeline/`, run with `npx tsx`, then `rm`.
- Browser-pane `computer`/screenshot clicks time out when the pane isn't visibly shown — use
  `get_page_text` / `javascript_tool`. CSS transitions freeze mid-flight there
  (`getComputedStyle` returns stale interpolated values). media-gen MCP can be out of credits.
- `spawn npx ENOENT` on Windows → spawn `process.execPath` with the resolved `tsx/dist/cli.mjs`.
- Recorder: `waitForSelector` needs `:not([hidden])` or it resolves to the Next.js dev overlay;
  `__name is not defined` needs `page.addInitScript`.
- `apps-script/*.gs` is plain JS — no TypeScript annotations; verify with `node --check`.
- Verify Vercel deploys with `curl -sI`, not the Browser pane (false `ERR_BLOCKED_BY_CLIENT`).
- `templates/demo-site/` build leaves a `package-lock.json` that trips Next's workspace-root
  inference — delete build artifacts after any template verification so it ships depless.

---

## 12. Related memory files

`C:\Users\xdevi\.claude\projects\C--Users-xdevi-OneDrive-Desktop-Websites\memory\`
- `pipeline-architecture-notes.md` — Sheets store, manual demo build, `scaffolded`, Gmail degradation.
- `demo-site-workflow-feedback.md` — don't visually clone sibling demos; scrape real photos, use the skills.
- `execute-web-development-process.md` — the user's name for the full demo-site build pipeline.
- `browser-tool-headless-quirks.md`, `windows-dev-environment-constraints.md`.
