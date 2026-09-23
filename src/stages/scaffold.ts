/** Stage: scaffold demo sites for A-tier leads, capped per run. */
import { openStore } from '../store.ts';
import { scaffoldDemo } from '../scaffold.ts';
import { slugify } from '../normalize.ts';
import type { Stage, StageResult } from '../campaign-stages.ts';

export const scaffoldStage: Stage = {
  name: 'scaffold',
  description: 'scaffold demo sites for A-tier leads',
  async run(ctx): Promise<StageResult> {
    const store = openStore();
    const pool = (await store.all())
      .filter((l) => l.area === ctx.area && l.status === 'verified' && l.tier === 'A' && !l.demo_slug)
      .sort((a, b) => Number(b.osm_score) - Number(a.osm_score));

    if (pool.length === 0) return { processed: 0, summary: 'no A-tier leads awaiting a demo' };

    // Capped on purpose: you can service 3-5 clients a month, so scaffolding
    // twenty sites in one run would just burn disk and attention.
    const batch = pool.slice(0, ctx.caps.maxScaffolds);
    const done: string[] = [];

    for (const lead of batch) {
      const slug = slugify(lead.name);
      if (ctx.dryRun) { done.push(`${slug} (dry run)`); continue; }
      try {
        const r = scaffoldDemo({ slug, lead });
        await store.update(lead.lead_id, { demo_slug: r.slug, status: 'scaffolded' });
        ctx.log(`${lead.name} -> ${r.slug} on port ${r.port}`);
        done.push(`${r.slug}:${r.port}`);
      } catch (err) {
        ctx.log(`${lead.name} -> skipped: ${(err as Error).message}`);
      }
    }
    const held = pool.length - batch.length;
    return {
      processed: done.length,
      summary:
        `scaffolded (shell only) ${done.length} of ${pool.length} A-tier` +
        (held > 0 ? ` (${held} held back by the per-run cap)` : '') +
        (done.length ? `: ${done.join(', ')}` : ''),
      briefNotes: done.length
        ? ['Each scaffolded folder contains a `BUILD-PROMPT-<BusinessName>.md`. Open it in Claude Code and run `/demo-site-build` to design the demo.']
        : [],
    };
  },
};
