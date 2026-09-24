# Bugs

Found during the overnight pass (branch `overnight/pipeline-fix`). Baseline
before any change: `tsc` clean, 342/342 tests passing. Most of the problems
below are in how the parts fit together, not in the unit-tested functions.

Status: **fixed**, **mitigated** (made safe or visible, but the root cause
needs the owner), or **open**.

| # | Symptom | Root cause | Status |
|---|---|---|---|
| 1 | The four-stage flow (find → site → video → email) has never run end to end. | There was no orchestrator for it. `scaffold` stops at an empty Next.js shell that needs a person to design it. `record` needs a dev server started by hand. The outreach templates never mention a site or video link. Nothing writes `demo_url` or `video_url`. | fixed: `npm run pipeline` (`src/pipeline/`) |
| 2 | No way to run anything without touching live data. | `dataPath()` was hard-wired to `./data`, and `openStore()` picks the production Google Sheet whenever credentials exist. A test that reached `openStore()` would have written to the 997-row Sheet. | fixed: `PIPELINE_DATA_DIR` and `PIPELINE_STORE=json`, validated in `src/settings.ts`; tests and e2e use a temp dir |
| 3 | `record`, `harvest`, `publish` and `scaffold` cannot find any existing demo. | `WEBSITES_ROOT = <repo>/..` assumed the repo sits inside `OneDrive\Desktop\Websites\`. Since the move to `dev\tools\pipeline` that resolves to `dev\tools\`, which has no demos and no `.claude/launch.json`. | mitigated: `DEMO_SITES_ROOT` setting, and `doctor` reports it. The owner has to set it (Needs Jan). |
| 4 | `--max-verify abc` or `--max-scaffolds x` silently verifies or scaffolds nothing. | `Number('abc')` is `NaN`, and `slice(0, NaN)` returns `[]`. | fixed: validated positive-integer flags |
| 5 | A scaffold that fails is retried on every run, and the reason is lost. | The scaffold stage logged the error and left the lead at `verified`, with no record of the failure. | mitigated: the demo pipeline stores per-lead, per-stage `failed` with the error. The campaign's scaffold stage still only logs, because giving it a state column would change the production Sheet's schema. |
| 6 | Follow-up emails have no opt-out line. | `follow-up-7.md` and `breakup-14.md` had none. `follow-up-3.md` only said "say so". Only first contact had "Reply no thanks". | fixed: every email template ends with the same opt-out line, and rendering an email without it throws |
| 7 | The email signature has no way to reply except the thread. | `SENDER` had a name and a school but no address. | fixed: `SENDER_EMAIL` setting, printed in the demo email signature |
| 8 | Creating a Gmail draft can hang a run indefinitely. | `gmail.users.drafts.create` had no timeout and no retry. | fixed: wrapped in `withRetry` with a 30 s timeout per attempt |
| 9 | Sheet reads and writes can hang indefinitely. | googleapis calls had no timeout. | fixed: 30 s request timeout on the Sheets client |
| 10 | A walkthrough video can never be shorter than 20 s, so a smoke test costs a minute per business. | `planWalkthrough` hard-coded `MIN_TOTAL_MS`. | fixed: `minTotalMs` option, default unchanged |
| 11 | A send path, if one were ever added, had no guard. | There was no switch. The rule was only a comment. | fixed: `SEND_EMAILS` must be `false`, and the settings validation refuses `true` because no transport exists |
| 12 | The console dashboard showed no failed, running or pending state per stage, and had no retry. | The console only knew the campaign's single `status` column. | fixed: pipeline dashboard view (Phase 4) |
| 13 | `npm run lint` and `npm run build` did not exist. | Neither was ever set up. | fixed: ESLint (typescript-eslint) and a `tsc` emit build to `dist/` |
| 14 | The built JavaScript could not find `config/` or `templates/`. | `ROOT` was computed as "one directory up from this file". That holds for `src/x.ts` and fails for `dist/src/x.js`. | fixed: `ROOT` walks up to the nearest `package.json`. Proven by running the fixture pipeline from `dist/` under plain `node`. |
| 15 | Verify loses the review count whenever the Maps panel settles slowly. | The fallback `N reviews` regex in `src/fetcher.ts` held a literal backspace character (0x08) where `\b` was meant, so it could never match. It had been there since the first Maps commit (`da16f7c`). ESLint's `no-control-regex` found it. | fixed: `parseReviewCount`, with a regression test. A byte scan of every tracked text file found no other control characters. |
| 16 | Copying `.env.example` to `.env.local` would stop every command at startup. | Blank template values (`PIPELINE_STORE=`) failed validation instead of meaning "unset". Caught by a new test that validates the template itself. | fixed |
| 17 | A compiled Python cache was committed. | `bin/__pycache__/*.pyc` was never ignored. | fixed: untracked (still on disk) and `__pycache__/` ignored |
| 18 | `.env.example` pointed at a stale OneDrive path and named the service-account key file. | Left over from before the repo moved. | fixed: now a placeholder with the `.secrets` convention |

## Not bugs (checked, left alone)

- **Gmail token** (`GMAIL_TOKEN_PATH` has no `refresh_token`). The owner
  deferred this. Drafts land in files instead, which works.
- **Overpass and Gemini** already had retries, backoff and timeouts.
- **The manual chain denylist** overlaps with the chain index on purpose. It
  catches name variants the exact index cannot (see HANDOFF §0b).
