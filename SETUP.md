# Setup

Everything here is optional except Step 1. The pipeline runs with **no
credentials at all** — it just does less. Each missing key degrades quietly
rather than crashing, which is right for unattended runs but means "nothing
errored" tells you nothing.

**`npm run doctor` is the source of truth.** Run it after every step. It
prints what is on, what is missing, and what each missing thing costs you.

---

## Step 1 — Install (required, 2 minutes)

```bash
cd C:\Users\xdevi\OneDrive\Desktop\Websites\pipeline
npm install
npm run doctor
```

You should see `[ok]` for node, python, ffmpeg, playwright chromium and
sharp. All five are already on this machine.

If the chain index is missing or older than 90 days:

```bash
npm run chain-index
```

That is one Overpass query over Metro Manila (~30s). It builds the filter
that separates real independents from chains, and **everything downstream
depends on it being right**.

At this point the pipeline fully works. The store is a local JSON file, the
outreach drafts land in `data/drafts/`, and photo curation is skipped. The
next three steps each switch one of those on.

---

## Step 2 — Gemini key (free, no credit card, 3 minutes)

**Unlocks:** photo curation, menu-graphic OCR, brand description for
`DESIGN.md`. Without it photos still download — only the AI curation stops.

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account
3. **Create API key** → pick or create a project → copy the key

Then:

```bash
cp .env.example .env.local
```

Open `.env.local` and set:

```
GEMINI_API_KEY=your-key-here
```

Verify:

```bash
npm run doctor
```

Look for `[ok] GEMINI_API_KEY set` and `[on] harvest`.

> **Free tier reality check.** No billing account is needed. You get roughly
> 250–1,500 requests/day depending on model; at ~60 leads/month you will use
> under 1% of it. **Grounding with Google Search is NOT on the free tier** —
> Gemini cannot browse. It only ever reads text and images a script already
> fetched. Free-tier content is used to improve Google's models, so only
> public business data is ever sent — never client contracts or your inbox.

---

## Step 3 — Google Sheets store (free, no card, ~10 minutes)

**Unlocks:** the lead store moves from a local JSON file to a shared Sheet
you can open on your phone. Until then everything still works locally.

### 3a. Create the Sheet

1. Make a new Google Sheet
2. Rename the first tab to **`Leads`** (exact, capital L — or set
   `GOOGLE_SHEET_TAB` to whatever you named it)
3. From the URL, copy the ID:
   `docs.google.com/spreadsheets/d/`**`THIS_LONG_PART`**`/edit`

Leave the sheet empty. The header row is written from the code's column
list on first use, so it can never drift out of sync.

### 3b. Create a service account

The Sheets API does **not** require a billing account. This is the key
difference from Google Maps Platform, and it is why this route works for
you at all.

1. **https://console.cloud.google.com/** → create a project (any name)
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**
3. **APIs & Services → Credentials** → **Create credentials → Service account**
4. Give it a name, **Create and continue**, skip the optional role steps, **Done**
5. Click the new service account → **Keys** → **Add key → Create new key → JSON**
6. A `.json` file downloads. **Move it somewhere outside OneDrive** — for
   example `C:\Users\xdevi\.secrets\pipeline-sa.json`. It is a credential;
   keep it out of a synced folder and out of git.

### 3c. Share the Sheet with the service account

Open that JSON and find `"client_email"` — something like
`pipeline@your-project.iam.gserviceaccount.com`.

In your Sheet: **Share** → paste that address → give it **Editor** → Send.

**This step is the one everybody forgets.** The service account is a
separate identity; it cannot see your Sheet until you share it, and the
failure looks like a permissions error, not a setup mistake.

### 3d. Point the pipeline at it

In `.env.local`:

```
GOOGLE_SHEET_ID=the-long-id-from-the-url
GOOGLE_SA_KEY_PATH=C:\Users\xdevi\.secrets\pipeline-sa.json
```

```bash
npm run doctor
```

`store:` should now read **`sheets`** instead of `json`.

> Your existing 662 local leads are **not** migrated automatically. Either
> start fresh (re-run `npm run source`, it is idempotent) or ask me to write
> a one-off importer.

---

## Step 4 — Gmail drafts (optional, ~15 minutes)

**Unlocks:** outreach lands in your Gmail Drafts instead of files in
`data/drafts/`. **Nothing is ever sent automatically either way** — you
review and press send yourself, always.

Honestly: this is the fiddliest step for the smallest gain. Copy-pasting
from `data/drafts/` works fine. Skip it until the rest is running.

The token file needs a real `refresh_token`. The JSON you download from Google Cloud
is only the OAuth *client* (`client_id` + `client_secret`) — mint the refresh token
once by hand:

1. Google Cloud Console -> APIs & Services -> enable **Gmail API**.
2. OAuth consent screen: External; add your own email as a **Test user**; scope
   `https://www.googleapis.com/auth/gmail.compose`.
3. Credentials -> your OAuth client (Desktop type is fine) -> note client_id / client_secret.
4. Open https://developers.google.com/oauthplayground/
   - gear icon -> "Use your own OAuth credentials" -> paste client id/secret
   - (Desktop client: also add `https://developers.google.com/oauthplayground` as an
     authorized redirect URI, or temporarily use a Web client)
   - Step 1: select scope `https://www.googleapis.com/auth/gmail.compose` -> Authorize
   - Step 2: "Exchange authorization code for tokens" -> copy the **refresh_token**
5. Create `C:\Users\xdevi\.secrets\gmail-token.json`:
   ```json
   {
     "client_id": "...",
     "client_secret": "...",
     "refresh_token": "1//0..."
   }
   ```
6. Point `.env.local` `GMAIL_TOKEN_PATH` at that file. Move the old client JSON out of
   `pipeline/` — it must not sit inside OneDrive or the repo.
7. `npm run doctor` should now report the Gmail token healthy.

Until this is done, outreach still runs — it writes drafts as markdown files into
`pipeline/data/drafts/` instead of creating Gmail drafts.

---

## Step 5 — The daily follow-up digest (optional, 5 minutes)

Runs on Google's servers, so it emails you **even with your PC off**.

1. Open your leads Sheet → **Extensions → Apps Script**
2. Delete the placeholder code, paste all of `apps-script/digest.gs`
3. **Save**
4. Click the **clock icon** (Triggers) → **Create new trigger**
   - Function: `digestLeads`
   - Event source: **Time-driven** → **Day timer** → **8am–9am**
5. **Save** → approve the permission prompt

It emails one batched digest of leads whose `next_action_date` is due and
that are not on the do-not-contact list. If nothing is due it sends nothing
at all — a daily "nothing to do" email just teaches you to ignore it.

---

## Daily use

```bash
npm run console          # http://localhost:3008 - draw an area, run it, read the inbox
npm run campaign         # or from the terminal: pick an area, run everything
```

One campaign run sources the area, verifies each lead against Maps,
classifies whether they have a *real* website, finds contacts, tiers them,
harvests photos and scaffolds sites for A-tier, drafts outreach for B-tier,
and writes you a handoff brief.

Then it stops, because three things cannot be automated: **designing the
demo** (that is a Claude Code session), **sending anything** (that is you),
and leads the browser could not verify past a consent wall.

### The rest of the commands

| Command | Does |
|---|---|
| `npm run doctor` | What is configured and what is missing |
| `npm run chain-index` | Rebuild the chain filter (quarterly) |
| `npm run source -- --area katipunan` | Sweep one area |
| `npm run worklist -- --area katipunan` | Manual verification list for what automation could not reach |
| `npm run new-demo -- --slug x --lead node/123` | Scaffold a demo site |
| `npm run harvest -- --slug x --ig @handle` | Pull and curate their photos |
| `npm run palette -- --slug x` | Sample a palette + WCAG contrast check |
| `npm run mockup -- --slug x` | 1200×1500 hero image for a DM |
| `npm run record -- --slug x` | Walkthrough video, 16:9 and 9:16 |
| `npm run draft -- --area katipunan` | Render outreach (drafts only) |
| `npm run publish -- --slug x` | Lint, build, deploy to Vercel, verify with curl |

Add `--dry-run` to `campaign`, `source`, `draft` and `publish` to see what
would happen without writing anything.

---

## Tuning

**`config/categories.json`** — the SME band.

- `phase: 1` is F&B, `phase: 2` is services. Sweeps default to phase 1; all
  five of your live demos are F&B, so the portfolio matches what you pitch.
- `sme.chainCutoff: 5` — a name with 5+ Metro Manila locations is dropped.
  **2–4 branches is a bonus, not a penalty** — those are growing businesses
  with budget.
- `sme.floor` — `minReviewCount: 30`, `minPhotoCount: 6`,
  `minIgFollowers: 300`. **This is the knob that most controls lead volume.**
  Loosen it if the funnel runs dry. Below-floor leads are parked as
  `nurture`, never deleted — a place with 12 reviews today may have 60 in
  six months.
- `sme.ceiling` — `maxReviewCount: 3000`, `maxIgFollowers: 50000`. Past
  this they already have a marketing team.

**`config/areas.json`** — bounding boxes. Easiest way to add one is drawing
a rectangle in the console; hand-writing coordinates is error-prone.

**`config/social-domains.json`** — what counts as "not a real website".
Facebook, Instagram, TikTok, Linktree and delivery-app listings live here.
A business whose only presence is one of these is your **best** prospect,
not a rejected one.

**`config/chains-manual.json`** — deliberately minimal. Only names the
generated index misses. Anything the index already catches was removed on
purpose, so it stays obvious which mechanism is doing the work.

**`templates/outreach/*.md`** — your actual message copy. Edit freely, but
every first-contact template must keep identifying you and carrying an
opt-out line. That is the compliance posture for cold B2B outreach under
RA 10173, and a test enforces it.

---

## Safety properties worth knowing

- **Nothing is ever sent automatically.** Email produces drafts; Instagram,
  Messenger and TikTok only ever write files for you to paste. Meta bans
  accounts for DM automation, so there is deliberately no send path.
- **`do_not_contact`** on any row suppresses that lead everywhere. Checked
  on every rendering path.
- **Re-running is safe.** The `status` column is the only state, so a
  crashed or interrupted run resumes exactly where it stopped and adds no
  duplicates. You can also just edit a status cell by hand to force a
  re-verify.
- **Caps per run** — 40 verifications, 3 scaffolds. You can handle 3–5
  clients a month; a run has no business scaffolding twenty sites.
- **`data/leads.json` is real business data.** Treat it as production.
