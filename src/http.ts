/** Small helpers for the console's loopback HTTP server. */
import type { IncomingMessage, ServerResponse } from 'node:http';

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
