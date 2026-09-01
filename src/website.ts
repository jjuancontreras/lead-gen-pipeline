/**
 * Website classification - the heart of the qualification filter.
 *
 * The operative definition: a website is a SEPARATE STANDALONE SITE.
 * A Facebook page, Instagram, TikTok, Linktree or a GrabFood listing is
 * NOT a website. Businesses whose only web presence is one of those are the
 * highest-value prospects, not disqualified ones - they already invest in
 * being findable and have nowhere to send people.
 */
import { readFileSync } from 'node:fs';
import { configPath } from './config.ts';
import type { WebsiteKind } from './lead.ts';

interface SocialConfig {
  kinds: Record<string, string[]>;
  freeHostSuffixes: string[];
}

const cfg = JSON.parse(readFileSync(configPath('social-domains.json'), 'utf8')) as SocialConfig;

/** hostname matches domain exactly, or is a subdomain of it. */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain);
}

export interface WebsiteVerdict {
  kind: WebsiteKind;
  /** True only for a real, separate site the business controls. */
  isStandalone: boolean;
  hostname: string;
  /** A real site, but on a free subdomain - weak, and an upsell angle. */
  isFreeHost: boolean;
}

export function classifyWebsite(raw: string | null | undefined): WebsiteVerdict {
  const url = (raw ?? '').trim();
  if (!url) {
    return { kind: 'none', isStandalone: false, hostname: '', isFreeHost: false };
  }

  let hostname: string;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    hostname = new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Unparseable - treat as unknown rather than claiming a standalone site.
    return { kind: 'none', isStandalone: false, hostname: '', isFreeHost: false };
  }

  for (const [kind, domains] of Object.entries(cfg.kinds)) {
    if (domains.some((d) => hostMatches(hostname, d))) {
      return { kind: kind as WebsiteKind, isStandalone: false, hostname, isFreeHost: false };
    }
  }

  const isFreeHost = cfg.freeHostSuffixes.some((s) => hostname.endsWith(s));
  return {
    kind: isFreeHost ? 'free_host' : 'standalone',
    // A free-host site IS a real site - it disqualifies, but flags an upsell.
    isStandalone: true,
    hostname,
    isFreeHost,
  };
}

/** Social kinds that make a lead MORE attractive, not less. */
export const HIGH_INTENT_KINDS: ReadonlySet<WebsiteKind> = new Set<WebsiteKind>([
  'facebook', 'instagram', 'tiktok', 'linktree',
]);

export function isHighIntent(kind: WebsiteKind): boolean {
  return HIGH_INTENT_KINDS.has(kind);
}
