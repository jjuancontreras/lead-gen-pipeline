/**
 * Stage 1, find: confirm this lead is a business worth building a site for.
 *
 * Discovery itself (Overpass, Maps verification) is the campaign's job and
 * makes live calls; this stage takes a lead that discovery already produced,
 * or a fixture, and refuses anything the rest of the pipeline must not touch:
 * an opted-out business, a closed-out lead, or one that already has a site.
 */
import { slugify } from '../../normalize.ts';
import { INACTIVE, isSuppressed, type Lead } from '../../lead.ts';
import { FoundLead } from '../schemas.ts';
import type { PipelineStage } from '../stage.ts';

/** One slug per lead: two businesses sharing a name must not share a folder. */
export function demoSlug(lead: Pick<Lead, 'name' | 'lead_id'>): string {
  return `${slugify(lead.name)}-${slugify(lead.lead_id)}`;
}

/** Why this lead cannot go through the pipeline, or null if it can. */
export function findRefusal(lead: Lead): string | null {
  if (isSuppressed(lead)) return 'do_not_contact is set - nothing is built for this business';
  if (INACTIVE.has(lead.status)) return `lead is "${lead.status}" - closed out, not a prospect`;
  if (lead.has_website === 'yes') {
    return `already has a website (${lead.website_url || lead.website_kind})`;
  }
  if (lead.has_website !== 'no') {
    return 'website not verified yet - run the campaign verify stage (or the worklist) first';
  }
  if (!lead.name.trim()) return 'lead has no business name';
  if (!lead.category.trim()) return 'lead has no category';
  return null;
}

export const findStage: PipelineStage<'find'> = {
  name: 'find',
  description: 'confirm a real business with no website',
  async run({ lead }, ctx) {
    const refusal = findRefusal(lead);
    if (refusal) throw new Error(refusal);
    return FoundLead.parse({
      lead_id: lead.lead_id,
      slug: demoSlug(lead),
      name: lead.name.trim(),
      category: lead.category.trim(),
      area: lead.area,
      areaLabel: ctx.areaLabel(lead.area),
      cuisine: lead.cuisine,
      phone: lead.phone.trim(),
      email: lead.email.trim(),
      instagram: lead.instagram.trim(),
      facebook: lead.facebook.trim(),
      tiktok: lead.tiktok.trim(),
      mapsUrl: lead.maps_url.trim(),
      lat: lead.lat,
      lng: lead.lng,
    });
  },
  isIntact: () => true,
};
