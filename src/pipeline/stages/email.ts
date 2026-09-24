/**
 * Stage 4, email: draft the personalized demo email.
 *
 * The draft is a markdown file a person opens, reads and sends from their own
 * mailbox (`<data dir>/emails/<slug>.md`, same format as the outreach
 * drafts). `ctx.mailer.send` is behind `ctx.sendEmails`, which settings pin
 * to false.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate } from '../../outreach.ts';
import { draftFileBody } from '../../draft-file.ts';
import { today } from '../../dates.ts';
import { EmailDraft } from '../schemas.ts';
import { need, type PipelineStage } from '../stage.ts';

export const emailsDir = (dataDir: string) => join(dataDir, 'emails');
export const DEMO_TEMPLATE = 'email-demo';

export const emailStage: PipelineStage<'email'> = {
  name: 'email',
  description: 'draft the outreach email (never sent)',
  async run({ lead, found, site, video }, ctx) {
    const f = need(found, 'find');
    const s = need(site, 'site');
    const v = need(video, 'video');
    const to = lead.email.trim();
    if (!to) throw new Error('no email address on record - add one to the lead, then retry this stage');
    if (!ctx.senderEmail) throw new Error('SENDER_EMAIL is not set - an email must say who it is from');

    const rendered = renderTemplate(DEMO_TEMPLATE, lead, {
      site_url: s.url,
      video_url: v.url,
      video_seconds: String(Math.max(1, Math.round(v.durationMs / 1000))),
      sender_name: ctx.senderName,
      sender_email: ctx.senderEmail,
    });

    mkdirSync(emailsDir(ctx.dataDir), { recursive: true });
    const path = join(emailsDir(ctx.dataDir), `${f.slug}.md`);
    writeFileSync(path, draftFileBody(lead, 'email', DEMO_TEMPLATE, rendered, today()));

    let sent = false;
    if (ctx.sendEmails) {
      await ctx.mailer.send({ to, subject: rendered.subject ?? '', body: rendered.body });
      sent = true;
    }
    return EmailDraft.parse({
      path, to, subject: rendered.subject, body: rendered.body,
      siteUrl: s.url, videoUrl: v.url, sent,
    });
  },
  isIntact: (out) => existsSync(out.path),
};
