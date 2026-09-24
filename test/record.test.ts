import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planWalkthrough, ffmpegArgs, cssColorToFfmpeg, MIN_TOTAL_MS, MAX_TOTAL_MS, HARD_MAX_DWELL_MS,
} from '../src/record.ts';

const layout = { pageHeight: 4000, viewportHeight: 1000 };

test('a walkthrough starts at the top and ends at the footer', () => {
  const plan = planWalkthrough([0, 900, 1800, 2700], layout);
  assert.equal(plan.stops[0]!.y, 0);
  assert.equal(plan.stops.at(-1)!.y, 3000);
});

test('by default a short page is stretched toward the 20 s floor, dwell capped', () => {
  const plan = planWalkthrough([0, 400], { pageHeight: 1500, viewportHeight: 1000 });
  assert.equal(plan.stretched, true);
  assert.equal(plan.stops[1]!.dwellMs, HARD_MAX_DWELL_MS, 'dwell is stretched to its cap');
});

test('a page long enough reaches the 20 s floor', () => {
  const plan = planWalkthrough([0, 1000, 2000], layout);
  assert.ok(plan.estimatedMs >= MIN_TOTAL_MS, `planned ${plan.estimatedMs} ms`);
});

test('a long page is kept under the ceiling', () => {
  const tops = Array.from({ length: 40 }, (_, i) => i * 600);
  const plan = planWalkthrough(tops, { pageHeight: 25_000, viewportHeight: 1000 });
  assert.ok(plan.estimatedMs <= MAX_TOTAL_MS, `planned ${plan.estimatedMs} ms`);
});

test('no jump is longer than about one screen', () => {
  const plan = planWalkthrough([0, 3500], { pageHeight: 6000, viewportHeight: 1000 });
  for (let i = 1; i < plan.stops.length; i++) {
    assert.ok(plan.stops[i]!.y - plan.stops[i - 1]!.y <= 1100, `jump at stop ${i}`);
  }
});

test('REGRESSION: minTotalMs lowers the floor for a short smoke-test video', () => {
  const plan = planWalkthrough([0, 900, 1800], layout, { targetMs: 6000, minTotalMs: 4000 });
  assert.ok(plan.estimatedMs < MIN_TOTAL_MS, `planned ${plan.estimatedMs} ms`);
  assert.ok(plan.estimatedMs >= 4000, `planned ${plan.estimatedMs} ms`);
});

test('ffmpeg output is H.264 yuv420p - the only thing Messenger and QuickTime accept', () => {
  const a = ffmpegArgs('in.webm', 'out.mp4', '16x9');
  assert.ok(a.includes('libx264'));
  assert.equal(a[a.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(a.at(-1), 'out.mp4');
});

test('cssColorToFfmpeg converts rgb() and falls back on anything else', () => {
  assert.equal(cssColorToFfmpeg('rgb(17, 17, 17)'), '0x111111');
  assert.equal(cssColorToFfmpeg('rgba(255, 0, 128, 0.5)'), '0xff0080');
  assert.equal(cssColorToFfmpeg('transparent', '0xabcdef'), '0xabcdef');
});
