/**
 * The one browser this pipeline presents as, wherever it loads a page: Maps,
 * social pages and image CDNs all see the same logged-out visitor in Manila.
 * Kept free of Playwright imports so plain-HTTP callers can share it cheaply.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Options for every Playwright context that reads a page. */
export const CONTEXT_OPTIONS = {
  userAgent: USER_AGENT, locale: 'en-PH', timezoneId: 'Asia/Manila',
  viewport: { width: 1280, height: 900 },
};

/** Assets a text-reading visit never needs; aborting them keeps loads fast. */
export const BLOCKED_ASSETS = '**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}';
