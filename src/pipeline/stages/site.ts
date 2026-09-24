/** Stage 2, site: write the business's demo page to `<data dir>/sites/<slug>/`. */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSiteHtml } from '../site-html.ts';
import { SiteArtifact } from '../schemas.ts';
import { need, type PipelineStage } from '../stage.ts';

export const sitesDir = (dataDir: string) => join(dataDir, 'sites');

export const siteStage: PipelineStage<'site'> = {
  name: 'site',
  description: 'generate a static demo site',
  async run({ found }, ctx) {
    const f = need(found, 'find');
    const dir = join(sitesDir(ctx.dataDir), f.slug);
    mkdirSync(dir, { recursive: true });
    const indexPath = join(dir, 'index.html');
    const html = renderSiteHtml(f, { senderName: ctx.senderName, year: new Date().getFullYear() });
    // Rewritten on every run: the page is a pure function of the lead, so a
    // corrected phone number in the store shows up on the next retry.
    writeFileSync(indexPath, html);
    return SiteArtifact.parse({
      slug: f.slug,
      dir,
      indexPath,
      url: `${ctx.publicBaseUrl}/sites/${f.slug}/`,
      bytes: statSync(indexPath).size,
    });
  },
  isIntact: (out) => existsSync(out.indexPath),
};
