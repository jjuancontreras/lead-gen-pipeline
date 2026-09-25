# CLAUDE.md — pipeline

Client-acquisition pipeline for Metro Manila small businesses. See `HANDOFF.md`
for the operating manual, `SETUP.md` for credentials, `docs/WORKFLOW.md` for the
day-to-day loop (the Work Queue), `docs/ARCHITECTURE.md` for how it is built.

Standing constraints (from earlier sessions, still in force):

- The Google Sheet is live production data. Never write to it outside a run
  the owner starts. Tests and dry runs use the JSON store in a temp directory.
- `do_not_contact` gates every outreach path (RA 10173).
- Nothing in this codebase sends a message. Drafts only.
- Credentials live in `C:\Users\xdevi\.secrets\`. Never print or commit them.
- `config/areas.json` edits and `data/` drafts in the working tree belong to
  the owner - never commit them.

## Overnight mission

FIRST: add the brief below to CLAUDE.md in the project root (create it if missing) under "## Overnight mission", then carry out all of it. I'm asleep: never ask me anything, decide yourself, apply fixes directly (don't just suggest), and log decisions in REPORT.md.

BRIEF: This app automates lead gen: (1) find local businesses without websites, (2) generate a website for each, (3) record a video walkthrough of the site, (4) draft a personalized outreach email. It's buggy and has never worked end to end.

HARD RULES: Work only on a new branch overnight/pipeline-fix; small commits; never push to main, force-push, or rewrite history. NEVER send real emails; put any send path behind SEND_EMAILS=false and mock it in tests. Never deploy/publish sites or touch DNS/hosting. Max 5 live paid-API/scraper calls total; otherwise use mocks/fixtures. Never print, edit, or commit secrets/.env. Never delete or overwrite real data; use a separate test DB. If something needs me (keys, logins, paid plans), mock it, list it under "Needs Jan" in REPORT.md, and keep going. Never pass tests by deleting, skipping, or weakening them.

PHASE 1: Map the codebase into docs/ARCHITECTURE.md (stages, inputs/outputs, services, data flow). Run the app and tests; log every bug in BUGS.md (symptom, root cause, status).

PHASE 2 BACKEND: Fix bugs in stage order, then add: validated typed schemas between stages, per-lead failure isolation, retries with backoff and timeouts on external calls, idempotent/resumable runs, per-lead per-stage status (pending/running/done/failed + error), centralized validated config, structured logging; remove dead code. Emails: sender identity, opt-out line, no unfilled placeholders. Sites: responsive, valid HTML, real business details.

PHASE 3 TESTS: Unit tests per stage, integration tests per handoff, and a one-command e2e dry-run on 3 fixture businesses asserting: lead loaded, site renders in a headless browser, video exists with non-zero duration, email draft has business name, site link, video link, opt-out line, no placeholders, and zero real emails sent.

PHASE 4 UI/UX: Dashboard of every lead's status per stage; loading/empty/error states; retry per failed lead/stage; previews of site, video, and email; form validation; responsive; accessible (labels, contrast, keyboard); one consistent design system. Verify with Playwright screenshots and no console errors.

PHASE 5: Write REPORT.md (what broke, what changed and why, decisions, Needs Jan, exact commands to run app/tests/e2e).

DONE ONLY WHEN you have run and shown real output in this session of: (1) full test suite with 0 failures, none skipped or deleted to get there, (2) lint and type check with 0 errors, (3) production build succeeding, (4) the e2e dry-run taking all 3 fixture businesses through all four stages with every stage "done" and zero real emails sent, (5) Playwright dashboard checks passing with no console errors, (6) git log --oneline showing CLAUDE.md, REPORT.md, and all changes committed on overnight/pipeline-fix.
