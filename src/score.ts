/**
 * Stage-2 scoring: who gets a demo, decided after verification.
 *
 * Stage 1 (see sme.ts) only ranks who is worth verifying. This decides
 * outcomes, so it applies both edges of the SME band plus the core filter.
 */
import type { CategoriesConfig } from './config.ts';
import type { Lead, Tier, Status } from './lead.ts';
import { classifyWebsite, isHighIntent } from './website.ts';

export interface Stage2Result {
  tier: Tier;
  status: Status;
  score: number;
  reasons: string[];
}

const num = (v: string): number | null => {
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null;
};

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
  const reviews = num(lead.review_count);
  const followers = num(lead.ig_followers);
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
  const belowFloor: string[] = [];
  if (reviews !== null && reviews < floor.minReviewCount) {
    belowFloor.push(`${reviews} reviews < ${floor.minReviewCount}`);
  }
  if (followers !== null && followers < floor.minIgFollowers) {
    belowFloor.push(`${followers} followers < ${floor.minIgFollowers}`);
  }
  const photos = num(lead.photo_count);
  if (photos !== null && photos < floor.minPhotoCount) {
    belowFloor.push(`${photos} usable photos < ${floor.minPhotoCount}`);
  }
  if (belowFloor.length > 0) {
    reasons.push('below SME floor: ' + belowFloor.join(', '));
    return { tier: 'C', status: 'nurture', score: 0, reasons };
  }

  // ---- scoring ---------------------------------------------------------
  let score = 0;

  if (isHighIntent(verdict.kind)) {
    // The strongest signal available: they invest in being findable online
    // and have nowhere to send anyone.
    score += 30;
    reasons.push(`only presence is ${verdict.kind} - nowhere to send customers`);
  } else {
    score += 12;
    reasons.push('no web presence at all');
  }

  const branches = num(lead.chain_locations) ?? 1;
  if (branches >= config.sme.multiBranchBonusMin && branches <= config.sme.multiBranchBonusMax) {
    score += 12;
    reasons.push(`${branches} branches - growing, has budget`);
  }

  const rating = num(lead.rating);
  if (rating !== null && rating >= 4.0) { score += 10; reasons.push(`${rating} rating`); }

  if (reviews !== null && reviews >= 100) { score += 8; reasons.push(`${reviews} reviews`); }
  else if (reviews !== null && reviews >= floor.minReviewCount) { score += 4; }

  if (photos !== null && photos >= 10) { score += 8; reasons.push(`${photos} photos`); }
  else if (photos !== null && photos >= floor.minPhotoCount) { score += 4; }

  // Contact reachability, weighted by the channel priority order.
  if (lead.email) { score += 10; reasons.push('email available'); }
  else if (lead.phone) { score += 5; reasons.push('phone available'); }
  else if (lead.instagram || lead.facebook) { score += 3; reasons.push('social DM only'); }
  else { score -= 8; reasons.push('no contact channel found'); }

  const tier: Tier = score >= 55 ? 'A' : score >= 32 ? 'B' : 'C';
  const status: Status = tier === 'C' ? 'nurture' : 'verified';
  return { tier, status, score, reasons };
}
