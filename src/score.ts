/**
 * Stage-2 scoring: who gets a demo, decided after verification.
 *
 * Stage 1 (see sme.ts) only ranks who is worth verifying. This decides
 * outcomes, so it applies both edges of the SME band plus the core filter.
 */
import type { CategoriesConfig } from './config.ts';
import type { Lead, Tier, Status } from './lead.ts';
import { classifyWebsite } from './website.ts';

export interface Stage2Result {
  tier: Tier;
  status: Status;
  score: number;
  reasons: string[];
}

interface ParsedNum {
  value: number | null;
  /** Present but not a number the scraper could actually have produced -
   *  as opposed to genuinely absent (empty string, not scraped yet). */
  malformed: boolean;
}

/**
 * Parse a scraped numeric field strictly.
 *
 * `Number()` alone conflates two very different situations into the same
 * `null`: a field that hasn't been scraped yet (empty string - the floor
 * and ceiling gates should skip it, per the "parked, never deleted"
 * design below) and a field that WAS scraped but came back garbage
 * (`"NaN"`, `"1.2K"`, `"45 reviews"` - the gates must not silently treat
 * that the same as "unknown", or a 10,000-review chain with a mangled
 * scrape sails past the ceiling). `malformed` lets the caller tell them
 * apart. `Number()` is also looser than the scraper's actual output
 * (`fetcher.ts` only ever emits `[\d,]+`): it accepts hex (`"0x10"`),
 * exponents (`"1e3"`) and negative numbers, none of which Google emits,
 * so those are rejected here too rather than silently parsed.
 */
function parseNum(v: string, opts: { decimal?: boolean } = {}): ParsedNum {
  const trimmed = String(v ?? '').trim();
  if (trimmed === '') return { value: null, malformed: false };
  const cleaned = trimmed.replace(/,/g, '');
  const pattern = opts.decimal ? /^\d+(\.\d+)?$/ : /^\d+$/;
  if (!pattern.test(cleaned)) return { value: null, malformed: true };
  return { value: Number(cleaned), malformed: false };
}

export function stage2(lead: Lead, config: CategoriesConfig): Stage2Result {
  const reasons: string[] = [];
  const { floor, ceiling } = config.sme;

  const verdict = classifyWebsite(lead.website_url);

  // ---- the core filter -------------------------------------------------
  // A real separate site means there is nothing to sell them.
  if (verdict.isStandalone) {
    reasons.push(
      verdict.isFreeHost
        ? `has a site on a free host (${verdict.hostname}) - upsell, not a build`
        : `already has a website (${verdict.hostname})`,
    );
    return { tier: '', status: 'disqualified', score: 0, reasons };
  }

  // ---- ceiling: too big ------------------------------------------------
  const reviewsP = parseNum(lead.review_count);
  const followersP = parseNum(lead.ig_followers);
  const reviews = reviewsP.value;
  const followers = followersP.value;
  if (reviews !== null && reviews > ceiling.maxReviewCount) {
    reasons.push(`${reviews} reviews - past the SME ceiling`);
    return { tier: '', status: 'disqualified', score: 0, reasons };
  }
  if (followers !== null && followers > ceiling.maxIgFollowers) {
    reasons.push(`${followers} followers - has a marketing team already`);
    return { tier: '', status: 'disqualified', score: 0, reasons };
  }

  // ---- floor: too small to pay or to need one --------------------------
  // Parked, never deleted: 12 reviews today may be 60 in six months.
  // A malformed (not merely absent) numeric field parks the lead the same
  // way: we cannot confirm it clears the floor OR the ceiling, so it must
  // not silently pass either gate - see parseNum's `malformed`.
  const belowFloor: string[] = [];
  if (reviewsP.malformed) {
    belowFloor.push(`review_count "${lead.review_count}" did not parse - can't confirm SME band`);
  } else if (reviews !== null && reviews < floor.minReviewCount) {
    belowFloor.push(`${reviews} reviews < ${floor.minReviewCount}`);
  }
  if (followersP.malformed) {
    belowFloor.push(`ig_followers "${lead.ig_followers}" did not parse - can't confirm SME band`);
  } else if (followers !== null && followers < floor.minIgFollowers) {
    belowFloor.push(`${followers} followers < ${floor.minIgFollowers}`);
  }
  const photosP = parseNum(lead.photo_count);
  const photos = photosP.value;
  if (photosP.malformed) {
    belowFloor.push(`photo_count "${lead.photo_count}" did not parse - can't confirm SME band`);
  } else if (photos !== null && photos < floor.minPhotoCount) {
    belowFloor.push(`${photos} usable photos < ${floor.minPhotoCount}`);
  }
  if (belowFloor.length > 0) {
    reasons.push('below SME floor: ' + belowFloor.join(', '));
    return { tier: 'C', status: 'nurture', score: 0, reasons };
  }

  // ---- scoring ---------------------------------------------------------
  let score = 0;

  if (verdict.kind !== 'none') {
    // Any listed presence counts the same, whether it's a social page
    // (isHighIntent's original scope) or a delivery-app / Google-listing
    // page: they invest in being findable online and have nowhere to send
    // anyone. Checking `kind !== 'none'` here (rather than website.ts's
    // isHighIntent, which we don't own) is what fixes the delivery_app /
    // marketplace case scoring +12 with the false "no web presence at all"
    // note - every kind classifyWebsite can return at this point (verdict
    // isStandalone already returned false above) is exactly that class of
    // presence.
    score += 30;
    reasons.push(`only presence is ${verdict.kind} - nowhere to send customers`);
  } else {
    score += 12;
    reasons.push('no web presence at all');
  }

  const branches = parseNum(lead.chain_locations).value ?? 1;
  if (branches >= config.sme.multiBranchBonusMin && branches <= config.sme.multiBranchBonusMax) {
    score += 12;
    reasons.push(`${branches} branches - growing, has budget`);
  }

  const rating = parseNum(lead.rating, { decimal: true }).value;
  if (rating !== null && rating >= 4.0) { score += 10; reasons.push(`${rating} rating`); }

  if (reviews !== null && reviews >= 100) { score += 8; reasons.push(`${reviews} reviews`); }
  else if (reviews !== null && reviews >= floor.minReviewCount) { score += 4; }

  if (photos !== null && photos >= 10) { score += 8; reasons.push(`${photos} photos`); }
  else if (photos !== null && photos >= floor.minPhotoCount) { score += 4; }

  // Contact reachability, weighted by the channel priority order.
  if (lead.email) { score += 10; reasons.push('email available'); }
  else if (lead.phone) { score += 5; reasons.push('phone available'); }
  else if (lead.instagram || lead.facebook) { score += 3; reasons.push('social DM only'); }
  // Small penalty only: Maps verification does not look at Instagram or
  // Facebook bios, so "none found" here usually means "not looked for yet".
  // A heavier penalty would drop good leads a whole tier before enrichment
  // has had a chance to run.
  else { score -= 3; reasons.push('no contact channel found yet'); }

  const tier: Tier = score >= 55 ? 'A' : score >= 32 ? 'B' : 'C';
  const status: Status = tier === 'C' ? 'nurture' : 'verified';
  return { tier, status, score, reasons };
}
