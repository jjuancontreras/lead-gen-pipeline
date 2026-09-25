/**
 * Write a `BUILD-PROMPT-<BusinessName>.md` into a freshly scaffolded demo
 * folder: a paste-ready brief telling whoever builds the site what is still
 * a placeholder and what to gather.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lead } from './lead.ts';

const MISSING = '_(not found — confirm during research)_';

/** Lead name → ASCII `[A-Za-z0-9]`-only Title case, spaces removed. */
function businessNameForFile(name: string): string {
  return name
    .normalize('NFKD')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const val = (v: string | undefined): string => (v && v.trim() ? v.trim() : MISSING);

export function writeBuildPrompt(
  { slug, lead, targetDir }: { slug: string; lead: Lead | undefined; targetDir: string },
): string {
  const displayName = lead?.name?.trim() || titleCase(slug.replace(/-/g, ' '));
  const fileBase = lead
    ? businessNameForFile(lead.name)
    : businessNameForFile(titleCase(slug.replace(/-/g, ' ')));
  const path = join(targetDir, `BUILD-PROMPT-${fileBase || 'Demo'}.md`);

  const dnc = (lead?.do_not_contact ?? '').trim();
  const dncLine = dnc && !['no', 'false', '0'].includes(dnc.toLowerCase())
    ? `- **DO NOT CONTACT — flag set (\`${dnc}\`). Do not draft or send any outreach.**`
    : `- do_not_contact: ${dnc ? `\`${dnc}\`` : 'not set'}`;

  const md = `# Build prompt — ${displayName}

slug: \`${slug}\`${lead ? ` · lead: \`${lead.lead_id}\`` : ''}

## Business

- Name: ${val(lead?.name)}
- Category: ${val(lead?.category)}
- Area: ${val(lead?.area)}
- Branch name(s): ${val(lead?.name)}
- Phone: ${val(lead?.phone)}
- mapQuery: ${val(lead?.name)}
- Branch count: ${val(lead?.chain_locations)}

## Contacts

- Email: ${val(lead?.email)}
- Phone: ${val(lead?.phone)}
- Instagram: ${val(lead?.instagram)}
- Facebook: ${val(lead?.facebook)}
- TikTok: ${val(lead?.tiktok)}
${dncLine}

## Assets to obtain

- [ ] Photos: \`cd pipeline && npm run harvest -- --slug ${slug} --ig <handle>\` (IG grid → sharp optimise → \`research/images\` + Gemini vision curation)
- [ ] Logo: pull from IG profile pic / Facebook avatar → \`public/images/\`
- [ ] Menu + prices: OCR from posted menu photos / delivery-app listing (harvest does menu OCR) → fill \`content.json > menu.categories\`; unconfirmed items → \`openItemsToConfirm\` rendered via \`OpenItemsNote\`
- [ ] Hours & address: from Google Maps listing → set \`branches[0].hoursVerified\`
- [ ] Palette: \`npm run palette -- --slug ${slug}\` (Pillow sampler) — NEVER invent colours

## State of this folder

- The palette in \`globals.css\` is the neutral grey PLACEHOLDER.
- \`content.json\` is a skeleton — menu, assets and copy are empty.
- \`DESIGN.md\` values are unfilled.
- Do NOT copy a sibling project's tokens.

## Build

\`/demo-site-build\` for **${displayName}** (slug \`${slug}\`, lead \`${lead?.lead_id ?? 'n/a'}\`)

Phases: research → palette → content → DESIGN.md → build/lint → parallel code-review + security-review → Vercel deploy.

## When done

1. Deploy it: \`npm run publish -- --slug ${slug}\` (Vercel). Publishing does not touch the lead.
2. In the Work Queue (\`npm run console\`, then /queue), click **Mark built** on this lead and
   paste the live URL. That is what moves the lead to \`demo_built\`.
3. Click **Record**, redeploy so \`public/demo/\` goes live, then set the video link and draft
   the pitch.
`;

  writeFileSync(path, md);
  return path;
}
