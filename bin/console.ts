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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, configPath, loadAreas } from '../src/config.ts';
import { openStore } from '../src/store.ts';

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

      // Argument list is fixed here and the area is validated above, so no
      // user string ever reaches a shell. spawn without a shell, too.
      const args = ['tsx', 'bin/campaign.ts', '--area', area];
      if (url.searchParams.get('dryRun') === '1') args.push('--dry-run');
      const child = spawn('npx', args, { cwd: ROOT, shell: false });

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

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  pipeline console -> http://localhost:${PORT}\n`);
});
