# Overnight report: `overnight/pipeline-fix`

**Result: the pipeline now works end to end.** Three fixture businesses go
through all four stages: found, site built, walkthrough video recorded,
email drafted. Every stage finishes `done`, in about 40 seconds, fully
offline, with zero emails sent. The same run also works from the compiled
build under plain `node`. A dashboard in the console shows every lead's
status in each stage, retries failed stages, and previews the site, video
and email.

Nothing was pushed, deployed or sent. The Google Sheet was only read, by
`npm run doctor`. Live paid-API or scraper calls used: **0 of 5**. Your
uncommitted `config/areas.json` and `data/` drafts are untouched.

The verification output is at the end of this file.

## What was broken

The full list, with root causes, is in [BUGS.md](BUGS.md) (20 entries). The
important ones:

1. **The four stages were never connected** (BUGS #1). `scaffold` stopped at
   an empty Next.js shell that needed a person to design it. `record` needed
   a dev server started by hand. No email template mentioned a site or a
   video, and nothing ever wrote `demo_url` or `video_url`. That is why it had
   never run end to end.
2. **There was no safe place to test** (#2). Data was hard-wired to `./data`,
   and the store picks the production Sheet whenever credentials exist.
3. **Maps verification lost review counts** (#15). A regex contained a
   literal backspace byte where `\b` was meant, so it had never matched since
   it was first written. ESLint found it; it is now fixed with a regression
   test.
4. **The console was open to any web page in your browser** (#19). A page
   could read lead contact data through DNS rebinding, or start a live
   campaign with a cross-site request. This predates tonight; the security
   review found it.
5. **Follow-up emails had no opt-out line** (#6). They now do, and rendering
   any email without one throws.
6. **`--max-verify abc` silently did nothing** (#4). All numeric flags are
   now validated.
7. **Demo tools look for demo sites in the wrong folder** (#3). Since the
   move out of OneDrive, `scaffold`, `record`, `harvest` and `publish` all
   look in `dev\tools\`. This one needs you; see Needs Jan.

## What changed, and why

### Backend (Phase 2)

- **`npm run pipeline`**: the demo pipeline, in `src/pipeline/`. It runs
  find, site, video and email for each lead.
  - **find** refuses opted-out, closed-out, unverified or website-having
    leads.
  - **site** renders a static, responsive page from the lead's own details
    only, with a footer saying it is a demo built from public listings. It
    passes `html-validate`'s recommended rules.
  - **video** serves that page on a throwaway loopback port and records it
    with the existing recorder (`src/record.ts`). The output is H.264, and
    ffprobe confirms the duration.
  - **email** drafts `templates/outreach/email-demo.md` with the site link,
    video link, sender name and address, and the opt-out line.
- **Typed hand-offs.** Each stage's output is a zod schema
  (`src/pipeline/schemas.ts`). It is checked when the stage produces it and
  again when the next stage reads it. For example, a video with no duration
  fails at the video stage and never reaches the email.
- **Per-lead, per-stage status** (`pending`, `running`, `done` or `failed`,
  plus the error and attempt count) lives in
  `<data dir>/pipeline-state.json`.
- **One lead's failure stays with that lead.** It is marked failed, later
  stages stay pending, and the run moves on.
- **Resumable.** A rerun skips done stages whose files still exist, rebuilds
  those whose files are gone, and retries failed or interrupted ones. A
  second e2e run is a no-op.
- **Retries and timeouts.** `withRetry` and `withTimeout` in `src/retry.ts`
  wrap the recorder, Gmail draft creation and Sheets calls. Overpass and
  Gemini already had their own. Gemini now shares the same backoff formula.
- **Central, validated config.** `src/settings.ts` checks every environment
  setting with zod at startup, and a bad value names the setting. All of them
  are documented in `.env.example`, which a test confirms is itself valid.
- **Structured logging.** `src/log.ts` writes one line per event with its
  stage and lead. `LOG_FORMAT=json` gives JSON lines.
- **Sending is locked off.** `SEND_EMAILS` must be `false`, and `true` is
  refused at startup. The one `mailer.send` call sits behind that flag, and
  the only transport that exists throws.
- **One run at a time.** A cross-process lock stops the CLI and the console
  from running the pipeline at once.
- **Dead code removed:** an unused store method, a speculative helper, a
  duplicated constant and a committed `.pyc` file.

### Tests (Phase 3)

The unit suite went from 342 to 445 tests. New coverage includes every stage,
each hand-off schema, the runner (isolation, resume, rebuild, a crash left
`running`, malformed hand-offs), the send gate (with a spy mailer), settings,
the static server's path containment, the request guard, and the run lock.

`npm run e2e` is the one-command dry run. It runs the real CLI on the three
fixtures in a temp folder and checks:

- each lead is loaded;
- each site renders in headless Chromium at desktop and phone widths, with
  no console errors and no network requests;
- each video exists and ffprobe reports a non-zero duration;
- each draft has the business name, both links, the sender and the opt-out
  line, with no placeholders;
- zero emails were sent;
- a rerun does nothing.

### Dashboard (Phase 4)

A new page at `http://localhost:3008/pipeline`, linked from the inbox.
Screenshots are in [docs/screenshots/](docs/screenshots).

- A table of every lead with a pill for each stage. Each pill has an icon and
  a word, so status never depends on colour alone.
- A failed stage shows its error and a **Retry** button.
- Previews of the site (sandboxed iframe), the video and the email, in a
  dialog with focus trapping, arrow-key tabs and Escape to close.
- Loading, empty and error states.
- A run form with inline validation. It shows how many leads are ready in
  each area, so an empty area is caught before submitting.
- On phones, table rows become cards.
- Built only from the console's existing tokens and components, so both
  pages share one design system.

`npm run test:ui` checks it in Playwright against the real console:

- all the states above, retry, previews, validation, keyboard reach and phone
  width;
- an axe scan with zero violations;
- the security guard;
- zero console errors.

### Tooling

- `npm run lint`: ESLint with the recommended typescript-eslint rules.
- `npm run build`: `tsc` compiles to `dist/`. The fixture pipeline runs from
  it under plain `node`, which needed the package-root fix (#14).
- `npm run check` runs lint, typecheck, test, build, e2e and test:ui in
  order.

### Reviews

A code reviewer and a security reviewer went over the whole branch. Neither
found a violation of the hard rules (no sending, opt-outs respected, tests
never touch the Sheet). Their findings are fixed and listed as BUGS #19
and #20.

## Decisions I made

| Decision | Why |
|---|---|
| Worked in `dev\tools\pipeline` | This is the app the brief describes, and the one we worked on last night. |
| Added the demo pipeline next to the campaign instead of rewriting the campaign | The campaign (source, verify, enrich, scaffold, outreach) makes live scraping calls, writes the production Sheet, and is well tested. The brief's "find" maps onto the leads the campaign already verified: `--area` takes verified tier-A leads with no website, the same pool `scaffold` uses. |
| A generated static site instead of the Next.js template | The template needs `npm install`, a dev server and a person designing it, so it cannot run unattended or offline. The static page is built only from real details and says it is a demo. The Next.js path is unchanged for demos you design by hand. |
| Stage status lives in a JSON file, not new Sheet columns | Adding columns would change the schema of 997 live rows that other tools read by position. |
| `SEND_EMAILS=true` is refused rather than wired to Gmail | Your standing rule is that nothing sends. The switch exists, is tested with a spy mailer, and cannot be turned on without a code change. |
| The email stage fails if the lead has no email, or `SENDER_EMAIL` is unset | Guessing an address, or sending anonymously, is worse than a visible failure you can fix and retry. |
| Email links point at `PUBLIC_BASE_URL`, default `http://localhost:3008` | Deploying was off-limits. The console serves `/sites/` and `/videos/`, so the links work locally, and changing one setting points them at real hosting. |
| Only the 16:9 video take in the pipeline | It is the email format. `npm run record` still makes both takes for hand-built demos. |
| zod for schemas, a hand-rolled logger | zod is the standard for this. A logger this small did not justify pino. |
| Browser tests have their own `tsconfig.e2e.json` | `src/` deliberately runs without DOM types (see `record.ts`). |
| The dashboard is a second page in the existing console | It reuses the design tokens and the "no innerHTML" rendering rule, and keeps the inbox as it was. |
| Screenshots from test runs go to git-ignored `test-results/` | Otherwise every test run would leave changed PNGs in your working tree. `docs/screenshots/` holds tonight's snapshot. |

## Needs Jan

1. **Set `SENDER_EMAIL`** in `.env.local`. Until you do, every email stage
   fails with a clear message. `npm run doctor` flags it.
2. **Decide where demos are hosted, and set `PUBLIC_BASE_URL`.** Right now
   the links in drafts only open on your machine. I did not deploy anything.
3. **Set `DEMO_SITES_ROOT=C:\Users\xdevi\OneDrive\Desktop\Websites`** in
   `.env.local` (BUGS #3). Without it, `scaffold`, `record`, `harvest` and
   `publish` look in `dev\tools\` and cannot find your existing demos.
4. **Read the new email copy** in `templates/outreach/email-demo.md`. I wrote
   it in your existing voice, with the same prices and opt-out, but it is new.
5. **Your first real run writes to the Sheet.**
   `npm run pipeline -- --area katipunan` records `demo_slug`, `demo_url`,
   `video_url` and status `demo_built` on the leads it finishes. That is the
   intended behaviour, but it will be the first write of those columns from
   this code.
6. **Carried over from last night:** the Gmail token (you deferred it), the
   `sharp` vulnerability (the fix is a breaking upgrade), and review
   finding #3 (the `notes` column).

## Commands

```bash
cd C:\Users\xdevi\dev\tools\pipeline
npm install

# the app
npm run console                  # http://localhost:3008  (dashboard: /pipeline)
npm run pipeline -- --fixtures test/fixtures/businesses.json   # safe demo run, JSON store in .pipeline-fixture/
npm run pipeline -- --area katipunan --limit 3                 # real leads (writes demo links to the store)
npm run pipeline -- --retry <lead_id>:<stage>                  # e.g. node/123:video
npm run pipeline -- --status
npm run doctor                   # what is configured, and what is not

# checks
npm test                         # unit + integration (~2 s)
npm run lint
npm run typecheck
npm run build                    # tsc to dist/
npm run e2e                      # the dry run: 3 fixtures through all 4 stages (~45 s)
npm run test:ui                  # Playwright dashboard checks (~15 s)
npm run check                    # all of the above, in order
```

## Verification

Every command below was run at the end of the session. The output is
trimmed to its summary lines.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | exit 0, no findings |
| Type check | `npm run typecheck` (src + browser tests) | exit 0 |
| Test suite | `npm test` | **445 tests, 445 pass, 0 fail, 0 skipped, 0 todo** (baseline was 342; none deleted or weakened) |
| Production build | `npm run build` | exit 0: 15 entry points in `dist/bin/`. The fixture pipeline also ran from `dist/` under plain `node`: 3 of 3 done |
| E2E dry run | `npm run e2e` | **8 of 8 pass.** Kapihan sa Kanto, Lola Nena's Kusina and Café Ñora & Sons Bakery: find, site, video and email all `done`. "3 lead(s): 3 fully done, 0 failed", **"emails sent: 0"** |
| Dashboard | `npm run test:ui` | **13 of 13 pass**, including axe with no violations and **zero console errors** |

One test assertion was rewritten during the night.
`test/draft-file.test.ts` checked for the withdrawal marker with a regex that
had a useless escape (`'\#'`). It now uses `includes` on the same literal
string, so it checks exactly the same thing.
