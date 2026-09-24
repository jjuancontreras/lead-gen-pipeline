/**
 * Contact extraction from a business's own pages. Pure - no network.
 *
 * The value of this module is in what it REFUSES. A Facebook tracking pixel
 * (facebook.com/tr?id=...) and a share button (facebook.com/sharer.php) sit on
 * nearly every SME page that has ever touched a marketing plugin, so a naive
 * /facebook\.com\/(\w+)/ writes "tr" or "sharer" into the facebook column of
 * EVERY lead. instagram.com/p/<id> is the same trap: an embedded post, not the
 * business's account.
 *
 * A missed handle costs one lead. A wrong handle costs trust in the whole
 * column - and you only find out after sending. So every candidate has to
 * clear a reserved-path denylist AND a shape check before it is returned.
 */

/** The channels a page can yield. `phone` comes from the Maps panel instead. */
export const ENRICHABLE = ['email', 'instagram', 'facebook', 'tiktok'] as const;
export type EnrichableChannel = (typeof ENRICHABLE)[number];

export type HandleKind = 'instagram' | 'facebook' | 'tiktok';

export type Handles = Partial<Record<EnrichableChannel, string>>;

/**
 * First path segments that belong to the platform, not to a business.
 *
 * Deliberately long. Every entry here is a URL that really does appear on
 * ordinary restaurant pages - embeds, share widgets, pixels, cookie notices -
 * and every one of them would otherwise pass a "looks like a word" test.
 */
const RESERVED: Record<HandleKind, ReadonlySet<string>> = {
  instagram: new Set([
    'p', 'reel', 'reels', 'tv', 'igtv', 'stories', 'story', 'explore', 'accounts',
    'direct', 'about', 'developer', 'developers', 'legal', 'privacy', 'terms',
    'help', 'api', 'oauth', 'challenge', 'emails', 'session', 'web', 'graphql',
    'static', 'embed', 'login', 'signup', 'hashtag', 'locations', 'topics',
    'invites', 'lite', 'blog', 'press', 'jobs', 'ads', 'business', 'creators',
    'security', 'download', 'sharer', 'share', 'l', 'u', 'n', 'a',
  ]),
  facebook: new Set([
    'sharer', 'sharer.php', 'share', 'share.php', 'shares', 'tr', 'plugins',
    'login', 'login.php', 'logout.php', 'recover', 'checkpoint', 'privacy',
    'policy', 'policies', 'help', 'dialog', 'ajax', 'connect', 'campaign',
    'careers', 'terms', 'terms.php', 'about', 'legal', 'settings', 'notes',
    'events', 'groups', 'group', 'watch', 'marketplace', 'gaming', 'messages',
    'bookmarks', 'permalink.php', 'photo.php', 'photo', 'photos', 'video.php',
    'video', 'videos', 'story.php', 'hashtag', 'search', 'home.php', 'r.php',
    'l.php', 'badges', 'business', 'ads', 'adsmanager', 'developers', 'docs',
    'security', 'mobile', 'apps', 'games', 'media', 'people', 'public',
    'directory', 'places', 'reel', 'reels', 'posts', 'notifications', 'x',
  ]),
  tiktok: new Set([
    'tag', 'music', 'video', 'discover', 'foryou', 'explore', 'upload', 'live',
    'search', 'embed', 'legal', 'about', 'privacy', 'terms', 'business', 'ads',
    'developers', 'login', 'signup', 'following', 'friends', 'trending', 'node',
    'effect', 'channel', 'browse', 'creators', 'safety', 'community-guidelines',
  ]),
};

/**
 * Shape of a real account name on each network. Facebook's 5-character
 * minimum is doing real work: it drops the one- and two-letter CDN paths
 * (staticxx.facebook.com/x/...) that survive the denylist.
 */
const SHAPE: Record<HandleKind, RegExp> = {
  instagram: /^[a-z0-9._]{1,30}$/,
  facebook: /^[a-z0-9.-]{5,50}$/,
  tiktok: /^[a-z0-9._]{2,24}$/,
};

/** Host prefix to strip so a full URL, a bare path and a bare handle all work. */
const HOST_PREFIX: Record<HandleKind, RegExp> = {
  instagram: /^(?:https?:)?(?:\/\/)?(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am|ig\.me)(?=\/|$)/i,
  facebook: /^(?:https?:)?(?:\/\/)?(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)(?=\/|$)/i,
  tiktok: /^(?:https?:)?(?:\/\/)?(?:[a-z0-9-]+\.)*tiktok\.com(?=\/|$)/i,
};

/**
 * Host scanners. These match the HOST ONLY and leave the path unconsumed, so a
 * link nested inside another link's query string - which is exactly how the
 * Facebook page plugin embeds a business's real page - is still found.
 *
 * The lookbehind is the same guard classifyWebsite() applies: "notfacebook.com"
 * must not match facebook.
 */
const HOST_SCAN: Record<HandleKind, RegExp> = {
  instagram: /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)\//gi,
  facebook: /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)\//gi,
  tiktok: /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*tiktok\.com\//gi,
};

/** Where a URL stops inside HTML source or extracted page text. */
const URL_END = /[\s"'<>\\\]}()]/;

const MAILTO_RE = /mailto:([^\s"'<>?&)\\\]]+)/gi;
const BARE_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,24}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,24}$/;

/**
 * A bare-address regex matches sprite filenames ("logo@2x.png") and minified
 * asset paths as eagerly as it matches addresses. A file extension sitting
 * where the TLD should be is the reliable tell.
 */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'tif', 'tiff',
  'ico', 'css', 'js', 'mjs', 'cjs', 'json', 'html', 'htm', 'php', 'xml',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'pdf', 'map',
  'zip', 'txt',
]);

/** Error reporters, site builders and template placeholders, not businesses. */
const VENDOR_DOMAINS: readonly string[] = [
  'sentry.io', 'wixpress.com', 'wix.com', 'sentry-cdn.com', 'squarespace.com',
  'godaddy.com', 'shopify.com', 'myshopify.com', 'cloudflare.com', 'w3.org',
  'schema.org', 'googleapis.com', 'gstatic.com', 'jsdelivr.net', 'unpkg.com',
  'cloudfront.net', 'wordpress.org', 'elementor.com', 'wpforms.com',
  'example.com', 'example.org', 'example.net', 'example.co', 'domain.com',
  'yourdomain.com', 'youremail.com', 'test.com', 'email.tld', 'sentry.local',
];

const PLACEHOLDER_LOCALS: ReadonlySet<string> = new Set([
  'email', 'youremail', 'your-email', 'your_email', 'name', 'yourname',
  'username', 'user', 'someone', 'example', 'test', 'test123', 'sentry',
  'abc', 'xyz', 'john.doe', 'jane.doe', 'firstname.lastname', 'sample',
]);

/**
 * Is this an address a person could actually reply from?
 *
 * Rejects three separate families of false positive: regex debris from asset
 * filenames, infrastructure addresses baked into every page built with a given
 * tool, and unattended mailboxes that make outreach bounce silently.
 */
export function isPlausibleBusinessEmail(email: string): boolean {
  const value = (email ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  if (!EMAIL_SHAPE.test(value)) return false;

  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (ASSET_EXTENSIONS.has(tld)) return false;
  if (VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return false;
  if (PLACEHOLDER_LOCALS.has(local)) return false;
  if (/^(?:no-?reply|do-?not-?reply)(?:[._-]|$)/.test(local)) return false;
  // A Sentry DSN public key reads as an address: <32 hex>@o12345.ingest.sentry.io
  if (/^[0-9a-f]{24,}$/.test(local)) return false;
  if (local.length > 64 || domain.length > 255) return false;
  return true;
}

/**
 * Facebook page identity, which arrives in three structurally different URL
 * shapes.
 *
 * profile.php?id= and /pages/<name>/<id> look like plumbing but ARE the
 * business - plenty of Philippine SME pages never claimed a vanity URL, and
 * rejecting those on shape alone would drop real leads at the source.
 */
function normalizeFacebookPath(path: string): string {
  const withoutHash = path.split('#')[0] ?? '';
  const q = withoutHash.indexOf('?');
  // A real Facebook path never contains a bare "&". One that does is a link
  // nested in somebody else's query string, so everything from the "&" on
  // belongs to the outer URL, not to this page.
  const pathname = (q === -1 ? withoutHash : withoutHash.slice(0, q)).split('&')[0] ?? '';
  const query = q === -1 ? '' : withoutHash.slice(q + 1);
  const segs = pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  const first = segs[0] ?? '';
  if (!first) return '';

  if (first === 'profile.php') {
    const id = /(?:^|&)id=(\d{5,25})(?:&|$)/.exec(query)?.[1];
    return id ? `profile.php?id=${id}` : '';
  }
  if (first === 'pages') {
    const name = segs[1] ?? '';
    const last = segs[segs.length - 1] ?? '';
    // /pages/category/Restaurant/... is a directory browse; a real page always
    // ends in its numeric page id.
    if (segs.length < 3 || name === 'category' || !/^\d{5,25}$/.test(last)) return '';
    return `pages/${name}/${last}`;
  }

  // /pg/<slug>/about is the same page as /<slug>.
  const raw = first === 'pg' ? (segs[1] ?? '') : first;
  const slug = raw.replace(/[.,;:!?]+$/, '');
  if (!slug || RESERVED.facebook.has(slug)) return '';
  if (/\.(?:php|html?|js|css|png|jpe?g|gif|svg|webp|ico)$/.test(slug)) return '';
  return SHAPE.facebook.test(slug) ? slug : '';
}

/**
 * Canonical form of one handle, or '' when the input is not a business account.
 * '@handle' for Instagram and TikTok, a page slug for Facebook.
 */
export function normalizeHandle(kind: HandleKind, raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/&amp;/gi, '&');
  if (!trimmed) return '';

  const hadHost = HOST_PREFIX[kind].test(trimmed);
  const path = trimmed.replace(HOST_PREFIX[kind], '').replace(/^\/+/, '');
  if (!path) return '';
  // Nothing was stripped, yet this is clearly a URL - so it is a URL on some
  // OTHER host. "notfacebook.com/kurocafe" would otherwise leave "https" as
  // the first path segment, which passes every shape check there is.
  if (!hadHost && /[/:]/.test(trimmed)) return '';

  if (kind === 'facebook') return normalizeFacebookPath(path);

  const first = path.split(/[/?#&]/)[0] ?? '';
  // TikTok accounts always live at /@handle. A bare first segment is a video,
  // a tag or a discover page - never an account.
  if (kind === 'tiktok' && hadHost && !first.startsWith('@')) return '';

  const handle = first.replace(/^@+/, '').replace(/[.,;:!?]+$/, '').toLowerCase();
  if (!handle || RESERVED[kind].has(handle)) return '';
  return SHAPE[kind].test(handle) ? '@' + handle : '';
}

/**
 * Social links reach us three ways: plain, JSON-escaped inside inline scripts
 * (https:\/\/instagram.com\/x), and percent-encoded inside a Facebook page
 * plugin's iframe src. Normalising all three up front is what lets one host
 * scan find every occurrence.
 */
function decodeCorpus(raw: string): string {
  return raw.replace(/\\\//g, '/').replace(/%2F/gi, '/').replace(/&amp;/gi, '&');
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function candidates(corpus: string, scan: RegExp): string[] {
  const out: string[] = [];
  for (const m of corpus.matchAll(scan)) {
    if (m.index === undefined) continue;
    const rest = corpus.slice(m.index);
    const end = rest.search(URL_END);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

/**
 * Most frequent value, ties broken by first appearance.
 *
 * A business's own handle appears in the header AND the footer AND the schema
 * block; a link to somebody else's account appears once. Frequency is a weak
 * signal on its own but it is free, and it breaks exactly the tie that matters.
 */
function pickMostCommon(values: readonly string[]): string | undefined {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const v of values) {
    const n = count.get(v) ?? 0;
    if (n > bestCount) { best = v; bestCount = n; }
  }
  return best;
}

function pickEmail(corpus: string): string | undefined {
  // An explicit mailto: is a stated intent to be contacted; a bare address
  // scraped out of body text might belong to the web designer's credit line.
  const mailtos = [...corpus.matchAll(MAILTO_RE)]
    .map((m) => decodeMaybe(m[1] ?? '').trim().toLowerCase())
    .filter(isPlausibleBusinessEmail);
  const fromMailto = pickMostCommon(mailtos);
  if (fromMailto) return fromMailto;

  const bare = [...corpus.matchAll(BARE_EMAIL_RE)]
    .map((m) => m[0].toLowerCase())
    .filter(isPlausibleBusinessEmail);
  return pickMostCommon(bare);
}

/** Every contact this page states about itself. An absent key means not found. */
export function extractHandles(text: string, html: string): Handles {
  const corpus = decodeCorpus(`${html ?? ''}\n${text ?? ''}`);
  const found: Handles = {};

  for (const kind of ['instagram', 'facebook', 'tiktok'] as const) {
    const handle = pickMostCommon(
      candidates(corpus, HOST_SCAN[kind])
        .map((c) => normalizeHandle(kind, c))
        .filter((h) => h !== ''),
    );
    if (handle) found[kind] = handle;
  }

  const email = pickEmail(corpus);
  if (email) found.email = email;
  return found;
}

/**
 * Which of the found contacts are safe to write.
 *
 * Enrichment runs after verification and after any hand-editing, so an
 * existing value always wins: a person who typed a handle into the sheet knows
 * something the scraper does not.
 */
export function contactPatch(
  existing: Partial<Record<EnrichableChannel, string>>,
  found: Handles,
): Partial<Record<EnrichableChannel, string>> {
  const patch: Partial<Record<EnrichableChannel, string>> = {};
  for (const channel of ENRICHABLE) {
    const current = (existing[channel] ?? '').trim();
    const discovered = (found[channel] ?? '').trim();
    if (current === '' && discovered !== '') patch[channel] = discovered;
  }
  return patch;
}
