/**
 * Rendering an outreach draft to a markdown file you can actually send from.
 *
 * The Gmail token is not wired up yet, so these files ARE the outreach UI:
 * you open one, click through to a prefilled compose window or copy each
 * field on its own, read it, and press Send yourself. Nothing here sends.
 *
 * Every payload lives in a fenced block, because a fence is the only thing a
 * markdown renderer puts a copy button on. Prose has to be selected by hand,
 * and a hand-selected email body drags the subject line in with it.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './normalize.ts';
import { dataPath } from './config.ts';
import { localDate, today } from './dates.ts';
import type { Channel, Rendered } from './outreach.ts';
import type { Lead } from './lead.ts';

/** Where drafts land while there is no working Gmail token. */
export const DRAFT_DIR = dataPath('drafts');

/** Where a human goes to send this by hand. */
export function destination(lead: Lead, channel: Channel): string {
  const raw = (lead[channel] ?? '').trim();
  return channel === 'email' ? raw : socialUrl(channel, raw);
}

/** A profile URL from a handle, a bare name or a URL already. */
export function socialUrl(channel: Exclude<Channel, 'email'>, value: string): string {
  const raw = value.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, '');
  if (channel === 'instagram') return `https://www.instagram.com/${handle}/`;
  if (channel === 'facebook') return `https://www.facebook.com/${handle}`;
  return `https://www.tiktok.com/@${handle}`;
}

// ---- untrusted text in markdown --------------------------------------------

/**
 * Business names, handles and URLs are scraped from third parties, and this
 * file is what a human reads immediately before deciding what to send. A name
 * carrying `](` or a newline could close a link early and render arbitrary
 * markdown - a fake instruction, a link to somewhere else - inside a document
 * that looks like ours. Everything outside a fence gets escaped.
 */
function mdInline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[`*_[\]()<>|\\]/g, '\\$&').trim();
}

/**
 * A link destination that cannot end the link early, or null if the value is
 * not an http(s) address at all. Null is the honest answer for a handle we
 * could not turn into a URL - a broken link is worse than none.
 */
function mdUrl(raw: string): string | null {
  // Stripping control characters is the point of this pattern.
  // eslint-disable-next-line no-control-regex
  const url = raw.trim().replace(/[\s\u0000-\u001f]+/g, '');
  if (!/^https?:\/\//i.test(url)) return null;
  return url.replace(/[()<>"`\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

// ---- fenced fields ----------------------------------------------------------

/**
 * A fence longer than any run of backticks inside the text.
 *
 * No template contains a backtick today. But a fence the content can break
 * out of would ship a mangled message to a real business, and the guard is
 * one line.
 */
function fenceMarker(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A labelled block: the fence earns the copy button, the heading names it. */
function field(label: string, value: string): string[] {
  const marker = fenceMarker(value);
  // Rendered bodies end in a newline; inside a fence that is just a blank
  // line you would paste into somebody's inbox.
  return [`### ${label}`, ``, marker, value.replace(/\n+$/, ''), marker, ``];
}

/**
 * The inverse of `field()`: recover every fenced block and the first
 * "Open ..." link from a rendered draft. This is the one place that knows
 * the fenced-field shape backwards as well as forwards, so both directions
 * stay in sync - a client that re-implemented this parse from scratch would
 * be a second, untested copy of the same format.
 */
export function parseDraftBody(markdown: string): { fields: Record<string, string>; link: string | null } {
  const fields: Record<string, string> = {};
  const re = /^### (.+?)\n\n(`{3,})[^\n]*\n([\s\S]*?)\n\2\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) fields[m[1]!.trim().toLowerCase()] = m[3]!;
  const linkMatch = markdown.match(/\[Open[^\]]*\]\((https?:\/\/[^)]+)\)/);
  return { fields, link: linkMatch ? linkMatch[1]! : null };
}

// ---- the Gmail compose link -------------------------------------------------

/**
 * Past this, browsers and Gmail start truncating. Returning null instead of a
 * too-long link fails visibly, rather than opening a compose window holding
 * three quarters of a message.
 */
export const MAX_COMPOSE_URL = 8000;

/**
 * encodeURIComponent leaves ( and ) literal, and a literal ) ends a markdown
 * link destination - the DM copy already contains "(If not, just say so...)".
 */
const enc = (s: string): string =>
  encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');

/**
 * A Gmail compose deep link, or null if it would be too long.
 *
 * This opens a compose window with the fields already filled in. It does not
 * send: a person still reads it and presses Send, which is the whole point.
 */
export function gmailComposeLink(to: string, subject: string, body: string): string | null {
  const url = 'https://mail.google.com/mail/?view=cm&fs=1'
    + `&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;
  return url.length > MAX_COMPOSE_URL ? null : url;
}

/** What the "open this" link is called, per channel. */
const OPEN_LABEL: Record<Channel, string> = {
  email: 'email',
  instagram: 'Instagram profile',
  facebook: 'Facebook page',
  tiktok: 'TikTok profile',
};

// ---- the draft file ---------------------------------------------------------

export function draftFileBody(
  lead: Lead, channel: Channel, template: string, r: Rendered, now: string = today(),
): string {
  const to = destination(lead, channel);
  const out = [
    `# ${mdInline(lead.name)}`,
    ``,
    `**Nothing here has been sent.** Every block below has its own copy button.`,
    `Read it, then send it yourself.`,
    ``,
    `- lead: ${mdInline(lead.lead_id)} (${lead.tier || 'no tier'}, ${lead.status})`,
    `- channel: **${channel}** -> ${mdInline(to)}`,
    `- template: \`${template}\``,
    `- rendered: ${now}`,
    ``,
  ];

  if (channel === 'email') {
    const link = gmailComposeLink(to, r.subject ?? '', r.body);
    out.push(link
      ? `[Open a prefilled Gmail compose window](${link}) - it opens a draft, it does not send.`
      : `_This message is too long to fit in a compose link. Copy the three fields below._`);
  } else {
    const url = mdUrl(to);
    out.push(url
      ? `[Open the ${OPEN_LABEL[channel]}](${url})`
      : `_No usable ${OPEN_LABEL[channel]} link - the raw handle is in the list above._`);
  }
  out.push(``, `---`, ``);

  if (channel === 'email') {
    out.push(...field('To', to));
    // A DM has no subject, and printing one above a DM just gets it pasted.
    if (r.subject) out.push(...field('Subject', r.subject));
    out.push(...field('Body', r.body));
  } else {
    // One paste, one block - you open the profile, you do not paste into a
    // "To" field.
    out.push(...field('Message', r.body));
  }
  return out.join('\n');
}

// ---- withdrawal -------------------------------------------------------------

/** Heading that marks a draft as retracted. Used by the index and by tests. */
export const WITHDRAWN_MARKER = '## DO NOT CONTACT';

/**
 * What replaces a draft when its lead turns out to be opted out.
 *
 * The file is overwritten rather than deleted on purpose: deleting loses the
 * record that we once drafted something, while leaving the old file in place
 * leaves a ready-to-send message for a business that has asked not to be
 * contacted. RA 10173 makes that a legal problem, not just an untidy one.
 */
export function withdrawnBody(name: string, now: string): string {
  return [
    `# ${name}`,
    ``,
    WITHDRAWN_MARKER,
    ``,
    `This lead is flagged \`do_not_contact\`, so the draft that was here has been`,
    `withdrawn on ${now} and its text removed. There is nothing left to send.`,
    ``,
    `Do not write a replacement by hand. Clearing the flag in the sheet is the`,
    `only way this business comes back into an outreach pool.`,
    ``,
  ].join('\n');
}

// ---- the index --------------------------------------------------------------

export const INDEX_FILE = 'INDEX.md';

/** Slug that would collide with the index on a case-insensitive filesystem. */
const INDEX_SLUG = INDEX_FILE.replace(/\.md$/, '').toLowerCase();

/**
 * The filenames a lead's draft may occupy, in preference order.
 *
 * Drafts are keyed on the slug of the business name, which two similar names
 * can share. Losing a draft to that is survivable - the next run rewrites it.
 * Losing a *withdrawal record* to it is not: that record is what RA 10173
 * cares about. The second name exists only for that case, so the ordinary
 * `<slug>.md` scheme is unchanged for everyone else.
 */
export function draftFileNames(lead: Lead): [string, string] {
  const slug = slugify(lead.name);
  const base = slug === INDEX_SLUG ? `${slug}-lead` : slug;
  return [`${base}.md`, `${base}-${slugify(lead.lead_id)}.md`];
}

/** One row per draft written this run. */
export interface DraftRow {
  name: string;
  channel: Channel;
  destination: string;
  tier: string;
  template: string;
  /** Basename, so the index can link to it relatively. */
  file: string;
}

/** A draft file left over from an earlier run. Listed, never parsed. */
export interface EarlierDraft {
  file: string;
  modified: string;
}

/**
 * Draft files this run did not write. Read from the directory listing only -
 * parsing old drafts to recover their metadata would break the moment the
 * format changes, which is what this whole change is doing.
 */
export function earlierDrafts(dir: string, written: ReadonlySet<string>): EarlierDraft[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // first run: nothing has created the directory yet
  }
  return names
    .filter((f) => f.endsWith('.md') && f !== INDEX_FILE && !written.has(f))
    .map((f) => ({
      file: f,
      modified: localDate(statSync(join(dir, f)).mtime),
    }))
    .sort((a, b) => (a.modified === b.modified
      ? a.file.localeCompare(b.file)
      : b.modified.localeCompare(a.modified)));
}

/** A draft retracted this run because its lead is opted out. */
export interface WithdrawnDraft {
  name: string;
  file: string;
}

/** Pure, so the index can be tested without a filesystem. */
export function draftIndexBody(
  rows: readonly DraftRow[], earlier: readonly EarlierDraft[], now: string,
  withdrawn: readonly WithdrawnDraft[] = [],
): string {
  const out = [
    `# Outreach drafts`,
    ``,
    `**Nothing here has been sent.** Rewritten on every \`npm run draft\`.`,
    ``,
    `## Ready to send - drafted ${now}`,
    ``,
  ];
  if (rows.length === 0) {
    out.push(`_Nothing new this run._`, ``);
  } else {
    for (const r of rows) {
      out.push(`- [ ] **${r.name}** - ${r.channel} -> ${r.destination}`
        + ` - tier ${r.tier || '?'}, \`${r.template}\` - [open](./${r.file})`);
    }
    out.push(``);
  }
  if (withdrawn.length > 0) {
    out.push(
      `## Withdrawn - do_not_contact`,
      ``,
      `These leads opted out. The drafts were emptied on ${now}; send nothing.`,
      ``,
    );
    for (const w of withdrawn) out.push(`- [${w.name}](./${w.file}) - retracted`);
    out.push(``);
  }
  if (earlier.length > 0) {
    out.push(
      `## Earlier drafts`,
      ``,
      `Written by a previous run. Delete one once you have sent it.`,
      ``,
    );
    for (const e of earlier) out.push(`- [ ] [${e.file}](./${e.file}) - ${e.modified}`);
    out.push(``);
  }
  return out.join('\n');
}
