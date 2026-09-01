/**
 * Overpass API client.
 *
 * Data (c) OpenStreetMap contributors, ODbL 1.0.
 * https://www.openstreetmap.org/copyright
 *
 * Two failure modes seen in practice, both handled below:
 *  1. A busy instance returns HTTP 200 with an XML/HTML body containing
 *     "Error: ... Dispatcher_Client ... timeout". Status code alone is not
 *     enough to detect failure.
 *  2. Mirrors go down independently. overpass-api.de was the only one of
 *     three reachable during development, so we try in order.
 */

import dns from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

/*
 * Network setup, required on this machine.
 *
 * Overpass hosts publish both A and AAAA records. This box has no working
 * IPv6 route, so every AAAA attempt fails ENETUNREACH, and Node's default
 * 10-second connect timeout then expires before the IPv4 attempt completes
 * against a loaded Overpass instance - surfacing as a bare "fetch failed"
 * across all four mirrors while curl -4 succeeds in ~11s.
 *
 * Pin to IPv4 and give the connect a realistic budget.
 */
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000, family: 4 },
    headersTimeout: 300_000,
    bodyTimeout: 300_000,
  }),
);

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

const USER_AGENT = 'jfer-lead-pipeline/0.1 (contact: jfercontreras03@gmail.com)';

export type Bbox = [south: number, west: number, north: number, east: number];

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: OsmElement[];
}

/** Stable lead id: "node/123456". Free to store indefinitely. */
export function elementId(el: OsmElement): string {
  return `${el.type}/${el.id}`;
}

/** Coordinates, whether the element is a node (lat/lon) or a way (center). */
export function elementLatLon(el: OsmElement): { lat: number; lon: number } | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lon: el.lon };
  }
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

/**
 * Build a query for a set of "key=value" category selectors.
 * Groups by OSM key so we emit one regex-matched statement per key
 * rather than one per category - far cheaper server-side.
 */
export function buildCategoryQuery(
  bbox: Bbox,
  categoryKeys: string[],
  opts: { timeout?: number; withCenter?: boolean } = {},
): string {
  const timeout = opts.timeout ?? 180;
  const byKey = new Map<string, string[]>();
  for (const key of categoryKeys) {
    const [k, v] = key.split('=');
    if (!k || !v) continue;
    const list = byKey.get(k) ?? [];
    list.push(v);
    byKey.set(k, list);
  }

  const bb = bbox.join(',');
  const statements = [...byKey.entries()].map(([k, vals]) => {
    // OSM tag values in our config are plain identifiers. Validate rather
    // than escape, so a malformed config fails loudly instead of building a
    // silently-wrong regex.
    for (const v of vals) {
      if (!/^[a-z0-9_]+$/i.test(v)) {
        throw new Error(`Unsafe category value in config: "${k}=${v}"`);
      }
    }
    const alt = vals.join('|');
    return `  nwr["${k}"~"^(${alt})$"]["name"](${bb});`;
  });

  const out = opts.withCenter ? 'out center tags;' : 'out tags;';
  return `[out:json][timeout:${timeout}];\n(\n${statements.join('\n')}\n);\n${out}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the body is an Overpass error page rather than JSON. */
function isErrorBody(text: string): boolean {
  const head = text.slice(0, 400);
  return !head.trimStart().startsWith('{');
}

function errorReason(text: string): string {
  const m = text.match(/Error<\/strong>:\s*([^<]+)/);
  if (m?.[1]) return m[1].trim().slice(0, 160);
  return text.slice(0, 160).replace(/\s+/g, ' ');
}

export interface RunOptions {
  /** Attempts per mirror before moving on. */
  retriesPerMirror?: number;
  timeoutMs?: number;
  onAttempt?: (msg: string) => void;
}

/** Run a query, failing over across mirrors with backoff. */
export async function runOverpass(
  query: string,
  opts: RunOptions = {},
): Promise<OverpassResponse> {
  const retries = opts.retriesPerMirror ?? 2;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const log = opts.onAttempt ?? (() => {});
  const problems: string[] = [];

  for (const mirror of MIRRORS) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const host = new URL(mirror).host;
      log(`  querying ${host} (attempt ${attempt}/${retries})...`);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(mirror, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
          signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok || isErrorBody(text)) {
          const reason = `${host}: HTTP ${res.status} - ${errorReason(text)}`;
          problems.push(reason);
          log(`    busy/failed: ${errorReason(text)}`);
          // Overpass rate-limits by slot; back off before trying again.
          await sleep(3000 * attempt);
          continue;
        }
        return JSON.parse(text) as OverpassResponse;
      } catch (err) {
        const reason = `${host}: ${(err as Error).message}`;
        problems.push(reason);
        log(`    error: ${(err as Error).message}`);
        await sleep(2000 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(
    `All Overpass mirrors failed.\n${problems.map((p) => '  - ' + p).join('\n')}`,
  );
}
