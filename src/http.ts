/** Small helpers for the console's loopback HTTP server. */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export interface RequestInfo {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

/**
 * Why the console must refuse this request, or null to serve it.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other web pages in
 * this machine's browser, and this console can start browser automation and
 * holds real businesses' contact details:
 *
 *   - DNS rebinding: a page on evil.example re-resolves its own name to
 *     127.0.0.1 and reads the API as same-origin. Its requests still carry
 *     `Host: evil.example`, so only our own host names are served.
 *   - Cross-site requests: a page can fire a GET or a form POST at localhost
 *     without reading the answer, and some routes act on the request alone
 *     (GET /api/campaign starts a campaign). Browsers label such requests
 *     with Sec-Fetch-Site and Origin; anything not from this origin is
 *     refused on /api/.
 *   - A form can POST text/plain that happens to parse as JSON, without a
 *     CORS preflight. POST bodies must be declared application/json.
 */
export function requestRefusal(req: RequestInfo, port: number): string | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) return `unexpected Host header "${host}"`;

  if (req.path.startsWith('/api/')) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request refused';
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return 'cross-origin request refused';
  }

  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return 'POST bodies must be sent as application/json';
  }
  return null;
}

export const MAX_BODY_BYTES = 1_000_000;

export function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

export class BadRequest extends Error {}

/** Parse a JSON body. A local tool still should not accept an unbounded one. */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}
