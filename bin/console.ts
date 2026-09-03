#!/usr/bin/env tsx
/**
 * Local pipeline console.
 *
 *   npm run console        then open http://localhost:3008
 *
 * Serves the map area-picker, the campaign launcher and the lead inbox.
 * A browser page cannot spawn Playwright, so this thin server does it and
 * streams the orchestrator's output back over SSE.
 *
 * The CLI remains the source of truth: this is a convenience layer, and if it
 * breaks nothing else is blocked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { ROOT, configPath, loadAreas } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { isSuppressed } from '../src/lead.ts';
import { renderTemplate, pickChannel, templateForChannel } from '../src/outreach.ts';
import { followUpTemplateFor } from '../src/cadence.ts';
import { sentPatch, DRAFTED } from '../src/mark-sent.ts';
import {
  draftFileNames, destination, gmailComposeLink, parseDraftBody, WITHDRAWN_MARKER, today,
} from '../src/draft-file.ts';
import { DRAFT_DIR, isOpeningEligible, isFollowUpDue } from '../src/stages/outreach.ts';

const PORT = 3008;
// Bound to loopback only. This console has no authentication and can start
// browser automation, so it must never be reachable from the network.
const HOST = '127.0.0.1';

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // A local tool still should not accept an unbounded body.
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function isValidBbox(b: unknown): b is [number, number, number, number] {
  return (
    Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    b[0]! < b[2]! && b[1]! < b[3]! &&
    b[0]! >= -90 && b[2]! <= 90 && b[1]! >= -180 && b[3]! <= 180
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = readFileSync(join(ROOT, 'console', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/console.css') {
      const css = readFileSync(join(ROOT, 'console', 'console.css'));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return res.end(css);
    }

    // The console's own JS, split into ES modules under console/js/. Path is
    // resolved and re-checked against the directory it must stay under -
    // this is loopback-only, but a URL is still not a trusted file path.
    if (url.pathname.startsWith('/js/') && url.pathname.endsWith('.js')) {
      const jsDir = join(ROOT, 'console', 'js') + sep;
      const filePath = normalize(join(ROOT, 'console', url.pathname));
      if (!filePath.startsWith(jsDir) || !existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const js = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }

    if (url.pathname === '/api/areas' && req.method === 'GET') {
      return json(res, 200, loadAreas());
    }

    if (url.pathname === '/api/areas' && req.method === 'POST') {
      const body = (await readBody(req)) as { key?: string; label?: string; bbox?: unknown };
      const key = (body.key ?? '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
        return json(res, 400, { error: 'key must be kebab-case' });
      }
      if (!isValidBbox(body.bbox)) {
        return json(res, 400, { error: 'bbox must be [south, west, north, east] with south<north and west<east' });
      }
      // Re-read immediately before writing: another session may have added an
      // area while this page was open.
      const areas = loadAreas();
      if (areas.areas[key]) return json(res, 409, { error: `area "${key}" already exists` });
      areas.areas[key] = { label: (body.label || key).trim(), bbox: body.bbox };
      writeFileSync(configPath('areas.json'), JSON.stringify(areas, null, 2) + '\n');
      return json(res, 201, { key, area: areas.areas[key] });
    }

    if (url.pathname === '/api/leads' && req.method === 'GET') {
      const all = await openStore().all();
      const area = url.searchParams.get('area');
      const rows = area ? all.filter((l) => l.area === area) : all;
      const counts: Record<string, number> = {};
      for (const l of rows) counts[l.status] = (counts[l.status] ?? 0) + 1;
      // Only send what the inbox renders; the full store is 600+ rows.
      const interesting = rows
        .filter((l) => l.status !== 'sourced')
        .sort((a, b) => Number(b.osm_score) - Number(a.osm_score))
        .slice(0, 200);
      return json(res, 200, { counts, total: rows.length, leads: interesting });
    }

    if (url.pathname === '/api/campaign' && req.method === 'GET') {
      const area = url.searchParams.get('area') ?? '';
      if (!loadAreas().areas[area]) return json(res, 400, { error: 'unknown area' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (event: string, data: string) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Spawn node directly against tsx's CLI entry rather than going through
      // `npx`. On Windows npx is npx.cmd, which spawn() cannot resolve without
      // a shell - it fails with ENOENT and the campaign never starts. Using
      // process.execPath keeps this shell-free (so the area string can never
      // reach a shell) and works on every platform.
      const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (!existsSync(tsxCli)) {
        return json(res, 500, { error: 'tsx not installed - run npm install' });
      }
      const args = [tsxCli, 'bin/campaign.ts', '--area', area];
      if (url.searchParams.get('dryRun') === '1') args.push('--dry-run');
      const child = spawn(process.execPath, args, { cwd: ROOT, shell: false });

      const pipe = (buf: Buffer) => {
        for (const line of buf.toString('utf8').split('\n')) {
          if (line.trim()) send('log', line);
        }
      };
      child.stdout.on('data', pipe);
      child.stderr.on('data', pipe);
      child.on('close', (code) => { send('done', String(code ?? 0)); res.end(); });
      req.on('close', () => child.kill());
      return;
    }

    if (url.pathname === '/api/draft' && req.method === 'GET') {
      const leadId = url.searchParams.get('lead') ?? '';
      const all = await openStore().all();
      const lead = all.find((l) => l.lead_id === leadId);
      if (!lead) return json(res, 404, { error: 'unknown lead' });
      if (isSuppressed(lead)) return json(res, 200, { kind: 'suppressed' });

      // Whatever is actually on disk wins - it is exactly what would be, or
      // was, sent, in the same format a human reads before pasting it. The
      // fenced markdown is parsed here, once, into the fields it always was
      // before it got flattened to a file - the browser gets data, not a
      // document to re-parse.
      for (const file of draftFileNames(lead)) {
        const path = join(DRAFT_DIR, file);
        if (!existsSync(path)) continue;
        const raw = readFileSync(path, 'utf8');
        if (raw.includes(WITHDRAWN_MARKER)) return json(res, 200, { kind: 'withdrawn', file });

        const { fields, link } = parseDraftBody(raw);
        const structured = Object.keys(fields).length > 0;
        return json(res, 200, {
          kind: 'draft', file, link,
          // The real channel a draft went out on, not guessed from which
          // fields happened to parse - `channel_used` is written the moment
          // draftOutreach() picks one.
          channel: lead.channel_used || undefined,
          to: fields.to, subject: fields.subject, body: fields.body ?? fields.message,
          // A handful of drafts on disk predate the fenced-field format and
          // have no "### Label" blocks to parse - fall back to the raw file
          // rather than silently returning nothing for them.
          markdown: structured ? undefined : raw,
          canMarkSent: lead.status === DRAFTED,
        });
      }

      // Nothing on disk: the real eligibility rule (also selectPool's),
      // not a hand-kept copy of it - a preview must never promise a
      // message for a lead a campaign run would not actually touch.
      if (!(isOpeningEligible(lead) || isFollowUpDue(lead, today()))) {
        return json(res, 200, { kind: 'none', reason: 'No draft or preview available at this stage.' });
      }
      const channel = pickChannel(lead);
      if (!channel) return json(res, 200, { kind: 'none', reason: 'No contact channel on file yet.' });
      const template = lead.status === 'tier1_sent'
        ? followUpTemplateFor(lead.first_contacted_at, today())
        : templateForChannel(channel);
      try {
        // Rendered but never flattened to a file and never written - a
        // preview of what a campaign run would draft, structured the same
        // way a real draft is, so there is something to read before running
        // one.
        const rendered = renderTemplate(template, lead);
        const to = destination(lead, channel);
        const link = channel === 'email' ? gmailComposeLink(to, rendered.subject ?? '', rendered.body) : to;
        return json(res, 200, {
          kind: 'preview', channel, to, subject: rendered.subject, body: rendered.body, link,
          canMarkSent: false,
        });
      } catch (err) {
        return json(res, 200, { kind: 'none', reason: (err as Error).message });
      }
    }

    if (url.pathname === '/api/sent' && req.method === 'POST') {
      const body = (await readBody(req)) as { lead_id?: string };
      const leadId = (body.lead_id ?? '').trim();
      if (!leadId) return json(res, 400, { error: 'lead_id required' });

      const store = openStore();
      const all = await store.all();
      const lead = all.find((l) => l.lead_id === leadId);
      if (!lead) return json(res, 404, { error: 'unknown lead' });
      // Same two guards bin/mark-sent.ts applies: only a drafted, non-suppressed
      // lead can be confirmed sent - a flag left off must never mark contact.
      if (lead.status !== DRAFTED) {
        return json(res, 400, { error: `lead is "${lead.status}", not "drafted" - nothing to confirm` });
      }
      if (isSuppressed(lead)) return json(res, 400, { error: 'lead is flagged do_not_contact' });

      const patch = sentPatch(lead, today());
      await store.update(lead.lead_id, patch);
      return json(res, 200, { ok: true, patch });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  pipeline console -> http://localhost:${PORT}\n`);
});
