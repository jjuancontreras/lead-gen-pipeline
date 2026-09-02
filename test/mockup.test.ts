import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WEBSITES_ROOT } from '../src/scaffold.ts';
import {
  MOCKUP_WIDTH,
  MOCKUP_HEIGHT,
  outputPathFor,
  nextViewportHeight,
  decodePng,
  pixelVariance,
} from '../src/mockup.ts';

/**
 * Fixture PNGs, generated once offline with node:zlib's deflateSync (the
 * same compressor decodePng's inflateSync must invert) rather than built at
 * test time, so these tests exercise decodePng against real PNG bytes -
 * chunk framing, zlib stream, and per-scanline filter byte included -
 * without pulling in an image library just to build test fixtures.
 *
 * SOLID: 4x3, every pixel mid-grey (128,128,128,255).
 * CHECKER: 4x3, alternating black/white.
 */
const SOLID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAEklEQVR4nGNoaGj4j4wZCAoAAPMxHfXziawMAAAAAElFTkSuQmCC';
const CHECKER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR4nGNgYGD4DwJwGoXDwADCqCoA5Wkd4yI9JRgAAAAASUVORK5CYII=';

/* -------------------------------------------------------------------------- */
/* Output shape                                                               */
/* -------------------------------------------------------------------------- */

test('MOCKUP_WIDTH x MOCKUP_HEIGHT is a portrait 4:5 canvas for a phone DM', () => {
  assert.equal(MOCKUP_WIDTH, 1200);
  assert.equal(MOCKUP_HEIGHT, 1500);
});

test('outputPathFor defaults to <WEBSITES_ROOT>/<slug>/demo/hero-mockup.png', () => {
  assert.equal(
    outputPathFor('gubat'),
    join(WEBSITES_ROOT, 'gubat', 'demo', 'hero-mockup.png'),
  );
});

test('outputPathFor honors an explicit --out path', () => {
  assert.equal(outputPathFor('gubat', 'C:/tmp/custom.png'), 'C:/tmp/custom.png');
});

/* -------------------------------------------------------------------------- */
/* nextViewportHeight - pure geometry, no browser needed                      */
/* -------------------------------------------------------------------------- */

test('nextViewportHeight grows the viewport for a hero shorter than the target', () => {
  // A 92vh hero measured at 1380px inside a 1500px viewport should scale up
  // toward a viewport where 92vh lands on 1500px (~1630).
  const next = nextViewportHeight(1500, 1380, 1500);
  assert.ok(next > 1500, `expected growth, got ${next}`);
  assert.ok(Math.abs(next - 1630) <= 5, `expected ~1630, got ${next}`);
});

test('nextViewportHeight leaves the viewport unchanged when the hero already fills the target', () => {
  assert.equal(nextViewportHeight(1500, 1500, 1500), 1500);
});

test('nextViewportHeight never shrinks below the current viewport for an overflowing hero', () => {
  // A hero taller than the target gets top-cropped later, not chased by
  // shrinking the viewport - shrinking would not even help a fixed-px hero.
  assert.equal(nextViewportHeight(1500, 2200, 1500), 1500);
});

test('nextViewportHeight is a no-op when nothing was measured', () => {
  assert.equal(nextViewportHeight(1500, 0, 1500), 1500);
  assert.equal(nextViewportHeight(1500, -10, 1500), 1500);
});

test('nextViewportHeight clamps to the max rather than growing unboundedly', () => {
  const next = nextViewportHeight(1500, 10, 1500, 4000);
  assert.equal(next, 4000);
});

/* -------------------------------------------------------------------------- */
/* decodePng - a real (tiny) PNG in, exact pixels out                         */
/* -------------------------------------------------------------------------- */

test('decodePng reads width/height and every pixel of a solid-color PNG', () => {
  const decoded = decodePng(Buffer.from(SOLID_PNG_BASE64, 'base64'));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.pixels.length, 4 * 3 * 4);
  for (let i = 0; i < decoded.pixels.length; i += 4) {
    assert.deepEqual(
      [decoded.pixels[i], decoded.pixels[i + 1], decoded.pixels[i + 2], decoded.pixels[i + 3]],
      [128, 128, 128, 255],
    );
  }
});

test('decodePng reads a checkerboard PNG pixel-exact, including the filter byte per row', () => {
  const decoded = decodePng(Buffer.from(CHECKER_PNG_BASE64, 'base64'));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      const idx: number = (y * decoded.width + x) * 4;
      const expected = (x + y) % 2 === 0 ? 0 : 255;
      assert.deepEqual(
        [decoded.pixels[idx], decoded.pixels[idx + 1], decoded.pixels[idx + 2]],
        [expected, expected, expected],
        `pixel (${x},${y})`,
      );
    }
  }
});

test('decodePng rejects a buffer that is not a PNG', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /signature/i);
});

/* -------------------------------------------------------------------------- */
/* pixelVariance - the blank-image guard                                      */
/* -------------------------------------------------------------------------- */

test('pixelVariance is ~0 for a flat image - this is what the blank-capture guard rejects', () => {
  const decoded = decodePng(Buffer.from(SOLID_PNG_BASE64, 'base64'));
  const stats = pixelVariance(decoded.pixels, decoded.width, decoded.height);
  assert.ok(Math.abs(stats.mean - 128) < 1e-9, `expected mean ~128, got ${stats.mean}`);
  assert.ok(stats.stdDev < 0.01, `expected ~0 stddev, got ${stats.stdDev}`);
});

test('pixelVariance is high for a checkerboard - this is what a real capture looks like', () => {
  const decoded = decodePng(Buffer.from(CHECKER_PNG_BASE64, 'base64'));
  const stats = pixelVariance(decoded.pixels, decoded.width, decoded.height);
  assert.ok(stats.stdDev > 50, `expected high stddev, got ${stats.stdDev}`);
});

test('pixelVariance handles a zero-size image without dividing by zero', () => {
  const stats = pixelVariance(new Uint8Array(0), 0, 0);
  assert.deepEqual(stats, { mean: 0, variance: 0, stdDev: 0 });
});
