/**
 * Serve a directory over loopback HTTP.
 *
 * The recorder needs a real URL for the demo site, and the console previews
 * sites and videos. Both go through `resolveStatic`, which refuses any path
 * that escapes the root: a URL is not a trusted file path, even on loopback.
 */
import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export const contentType = (path: string): string =>
  TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * The file a URL path names under `root`, or null if it is outside the root
 * or does not exist. A directory resolves to its index.html.
 */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const target = resolve(join(base, decoded));
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (!existsSync(target)) return null;
  const file = statSync(target).isDirectory() ? join(target, 'index.html') : target;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/** Stream a file, honouring a single byte Range - video players seek with them. */
export function sendFile(res: ServerResponse, file: string, range?: string): void {
  const size = statSync(file).size;
  const headers = { 'Content-Type': contentType(file), 'Accept-Ranges': 'bytes' };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Serve `root` on 127.0.0.1 at an ephemeral port. */
export async function startStaticServer(root: string): Promise<StaticServer> {
  const server = createServer((req, res) => {
    const file = resolveStatic(root, new URL(req.url ?? '/', 'http://x').pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    sendFile(res, file, req.headers.range);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}
