# The workflow: machines prepare, you craft

The business is a two-tier funnel (HANDOFF §1):

- **Tier 1** is volume: about 50–60 first touches a month, roughly 10 minutes
  each.
- **Tier 2** is craft: about 8–12 hand-built demos a month, 3–5 hours each.

The pipeline automates everything around the craft: finding leads, drafting,
scheduling, bookkeeping. It leaves you the parts that sell: choosing who gets
a demo, designing it, recording it, and pressing Send.

Everything you owe a lead shows up in one place: the **Work Queue**.

```bash
npm run console
```

Then open <http://localhost:3008/queue>.

## The loop

| Step | Who | Where | What happens |
|---|---|---|---|
| 1. Discover | machine, weekly | `npm run campaign -- --area <key>` | Source (OpenStreetMap), verify (Google Maps), enrich (social pages), then Tier-1 drafts. Leads the machine could not settle land in **Verify by hand**. |
| 2. Verify by hand | you | Queue → *Verify by hand* | Use the prebuilt Maps, search, Facebook and Instagram links, fill in what you find, and Save. It is classified, scored and tiered with the same rules as `worklist`. **Verify next 40 automatically** (pick an area first) runs the Maps verifier in the background. |
| 3. Choose demos | you | Queue → *Choose demos* | Verified tier-A leads. **Build a demo for this** on the ones worth 3–5 hours. Park or disqualify the rest. |
| 4. Build | you, with Claude Code | Queue → *Build* | **Build demo** scaffolds `<DEMO_SITES_ROOT>/<slug>/` with its content seed and BUILD-PROMPT. **Harvest Instagram photos** is optional. Run `/demo-site-build`, deploy (`npm run publish -- --slug <slug>`), then paste the live URL into **Mark built**. |
| 5. Record | machine, when you click | Queue → *Record* | **Record** films the live demo: a 16:9 take for email, a 9:16 take for DMs, and a hero PNG, all into `<slug>/public/demo/`. **Redeploy** so the video goes live. The link field is prefilled with where it will be hosted; click **Set video link**. |
| 6. Pitch | you | Queue → *Pitch* | **Draft pitch** writes the email (demo link, video link, your address, opt-out) to `data/drafts/<slug>-<id>-demo.md`. Send it yourself, then **Mark pitch sent**, which starts the 3/7/14 clock. |
| 7. Tier 1 | you | Queue → *Drafts to send* | Send the campaign's first-contact drafts, then **Mark as sent**. |
| 8. Follow up | you | Queue → *Follow-ups due* | Tier 1: `npm run draft` writes the next follow-up. Tier 2: send a short personal nudge about the demo, then **Mark nudged**. |
| 9. Conversations | you | Queue → *Conversations* | Log **Replied**, **Meeting booked**, **Won**, **Lost** or **Park**. Any answer stops the follow-up clock. |

## Rules that hold everywhere

- **Nothing is ever sent.** Every message is a draft file you send from your
  own mailbox or DMs. `SEND_EMAILS` must be `false`.
- **Opt-outs are final.** A lead with `do_not_contact` set leaves every queue
  group. Any move toward contact is refused; it can only be closed out.
- **Every status change goes through one rulebook** (`src/transitions.ts`),
  whether it comes from a button, `npm run sent` or the worklist.
- **The Google Sheet is the source of truth.** The queue reads it and writes
  single rows. The Sheet stays hand-editable.

## One-time setup

Set these in `.env.local`. `npm run doctor` and the queue's Setup banner both
flag anything missing.

| Setting | Why |
|---|---|
| `DEMO_SITES_ROOT=C:\Users\xdevi\OneDrive\Desktop\Websites` | Where your demo folders live. The default (the repo's parent folder) has been wrong since the repo moved. |
| `SENDER_EMAIL=...` | The pitch signs off with it. Drafting a pitch refuses without it. |
| `PORTFOLIO_URLS=https://...,https://...` | Live demos linked from first-contact emails. With none set, that line is simply left out. |
