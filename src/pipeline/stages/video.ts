/**
 * Stage 3, video: record a scrolled walkthrough of the demo site.
 *
 * The site is served from a throwaway loopback server for exactly as long as
 * the recording takes. The recorder itself is `src/record.ts`, the same one
 * `npm run record` uses for the hand-built Next.js demos: headless Chromium,
 * paced stops at each `data-section`, H.264 yuv420p via ffmpeg, then ffprobe
 * for the real duration. Only the 16:9 email take is made here.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { recordDemo } from '../../record.ts';
import { startStaticServer } from '../../static-server.ts';
import { withRetry } from '../../retry.ts';
import { VideoArtifact } from '../schemas.ts';
import { need, type PipelineStage } from '../stage.ts';

export const videosDir = (dataDir: string) => join(dataDir, 'videos');

/** Browser launch, page load and two ffmpeg passes on top of the walk itself. */
const OVERHEAD_MS = 120_000;

export const videoStage: PipelineStage<'video'> = {
  name: 'video',
  description: 'record a walkthrough video of the site',
  async run({ site }, ctx) {
    const s = need(site, 'site');
    const server = await startStaticServer(dirname(s.dir));
    try {
      const report = await withRetry(
        () => recordDemo({
          slug: s.slug,
          url: `${server.url}/${s.slug}/`,
          only: '16x9',
          outDir: join(videosDir(ctx.dataDir), s.slug),
          targetMs: ctx.videoMs,
          minTotalMs: ctx.videoMs,
          log: (m) => ctx.log.debug(m),
        }),
        {
          attempts: 2,
          timeoutMs: ctx.videoMs * 3 + OVERHEAD_MS,
          label: 'walkthrough recording',
          onRetry: (err) => ctx.log.warn('recording failed, retrying once', { err }),
        },
      );
      const take = report.takes[0];
      if (!take) throw new Error('the recorder produced no take');
      return VideoArtifact.parse({
        path: take.path,
        url: `${ctx.publicBaseUrl}/videos/${s.slug}/${basename(take.path)}`,
        durationMs: take.probe.durationMs,
        bytes: take.probe.bytes,
        width: take.probe.width,
        height: take.probe.height,
      });
    } finally {
      await server.close();
    }
  },
  isIntact: (out) => existsSync(out.path) && statSync(out.path).size > 0,
};
