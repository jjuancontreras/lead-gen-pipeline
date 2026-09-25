/**
 * The Tier-2 craft loop's two machine steps, around the part that is yours.
 *
 *   Build demo  scaffold the Next.js folder, seed content.json, write the
 *               BUILD-PROMPT - then you run /demo-site-build and deploy.
 *   Record      once it is live, film the deployed URL (16:9 for email,
 *               9:16 for DMs) and capture a hero PNG for DM pitches.
 *
 * Recordings land in the demo's own `public/demo/`, so the next deploy hosts
 * them next to the site and the pitch can link to them.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldDemo, readLaunchConfig, WEBSITES_ROOT } from './scaffold.ts';
import { recordDemo, portForSlug } from './record.ts';
import { generateMockup } from './mockup.ts';
import { slugify } from './normalize.ts';
import type { Lead } from './lead.ts';

export const demoSlugFor = (lead: Lead): string => lead.demo_slug || slugify(lead.name);

export const recordingDir = (root: string, slug: string): string => join(root, slug, 'public', 'demo');

/** Where the email video will live once the demo is redeployed. */
export const suggestedVideoUrl = (demoUrl: string, slug: string): string =>
  `${demoUrl.replace(/\/+$/, '')}/demo/${slug}-16x9.mp4`;

export const isRecorded = (root: string, slug: string): boolean =>
  existsSync(join(recordingDir(root, slug), `${slug}-16x9.mp4`));

export interface DemoKit {
  slug: string;
  path: string;
  port: number;
  /** The BUILD-PROMPT to open in Claude Code, if the folder has one. */
  buildPrompt: string | null;
  /** The folder already existed (a demo started by hand) and was adopted. */
  reused: boolean;
}

function findBuildPrompt(dir: string): string | null {
  const hit = readdirSync(dir).find((f) => /^BUILD-PROMPT-.*\.md$/.test(f));
  return hit ? join(dir, hit) : null;
}

/** Scaffold the demo folder, or adopt it if you already started one by hand. */
export function buildDemoKit(lead: Lead, root: string = WEBSITES_ROOT): DemoKit {
  const slug = demoSlugFor(lead);
  const path = join(root, slug);
  if (existsSync(path)) {
    const port = portForSlug(readLaunchConfig(join(root, '.claude', 'launch.json')), slug) ?? 0;
    return { slug, path, port, buildPrompt: findBuildPrompt(path), reused: true };
  }
  const r = scaffoldDemo({ slug, lead, root });
  return { slug: r.slug, path: r.path, port: r.port, buildPrompt: findBuildPrompt(r.path), reused: false };
}

export interface Recording {
  videos: string[];
  mockup: string;
}

/** Film the live demo and capture its hero. Needs `demo_url`. */
export async function recordLiveDemo(
  lead: Lead,
  opts: { root?: string; videoMs: number; log?: (m: string) => void },
): Promise<Recording> {
  if (!/^https?:\/\//.test(lead.demo_url)) throw new Error('no live demo URL on the lead - Mark built first');
  const root = opts.root ?? WEBSITES_ROOT;
  const slug = demoSlugFor(lead);
  const outDir = recordingDir(root, slug);
  const report = await recordDemo({
    slug, url: lead.demo_url, outDir, targetMs: opts.videoMs, minTotalMs: opts.videoMs, log: opts.log,
  });
  const hero = await generateMockup({
    slug, url: lead.demo_url, outPath: join(outDir, `${slug}-hero.png`), log: opts.log,
  });
  return { videos: report.takes.map((t) => t.path), mockup: hero.outPath };
}
