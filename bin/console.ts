#!/usr/bin/env tsx
/**
 * Local pipeline console.
 *
 *   npm run console        then open http://localhost:3008
 *
 * Serves the lead inbox, the map area-picker and campaign launcher, and the
 * demo-pipeline dashboard at /pipeline (routes in src/pipeline/console-routes.ts).
 * A browser page cannot spawn Playwright, so this thin server does it and
 * streams the orchestrator's output back over SSE.
 *
 * The CLI remains the source of truth: this is a convenience layer, and if it
 * breaks nothing else is blocked.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { ROOT, configPath, loadAreas } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { sentPatch, sentRefusal } from '../src/mark-sent.ts';
import { draftView } from '../src/draft-view.ts';
import { today } from '../src/dates.ts';
import { settings } from '../src/settings.ts';
import { json, readBody, BadRequest } from '../src/http.ts';
import { handlePipelineRoute } from '../src/pipeline/console-routes.ts';

const PORT = settings().consolePort;
// Bound to loopback only. This console has no authentication and can start
// browser automation, so it must never be reachable from the network.
const HOST = '127.0.0.1';

const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/pipeline': 'pipeline.html',
};
const STYLESHEETS = new Set(['/console.css', '/dashboard.css']);

function isValidBbox(b: unknown): b is [number, number, number, number] {
  return (
    Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    b[0]! < b[2]! && b[1]! < b[3]! &&
    b[0]! >= -90 && b[2]! <= 90 && b[1]! >= -180 && b[3]! <= 180
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);

  try {
    const page = PAGES[url.pathname];
    if (page) {
      const html = readFileSync(join(ROOT, 'console', page));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (STYLESHEETS.has(url.pathname)) {
      const css = readFileSync(join(ROOT, 'console', url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return res.end(css);
    }

    if (await handlePipelineRoute(req, res, url)) return;

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
      return json(res, 200, draftView(lead, today()));
    }

    if (url.pathname === '/api/sent' && req.method === 'POST') {
      const body = (await readBody(req)) as { lead_id?: string };
      const leadId = (body.lead_id ?? '').trim();
      if (!leadId) return json(res, 400, { error: 'lead_id required' });

      const store = openStore();
      const all = await store.all();
      const lead = all.find((l) => l.lead_id === leadId);
      if (!lead) return json(res, 404, { error: 'unknown lead' });
      const refusal = sentRefusal(lead);
      if (refusal) return json(res, 400, { error: refusal });

      const patch = sentPatch(lead, today());
      await store.update(lead.lead_id, patch);
      return json(res, 200, { ok: true, patch });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    // A streamed file (a video) can fail after its headers went out.
    if (res.headersSent) { res.end(); return; }
    json(res, err instanceof BadRequest ? 400 : 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address() as AddressInfo;
  console.log(`\n  pipeline console -> http://localhost:${port}\n  demo pipeline    -> http://localhost:${port}/pipeline\n`);
});
