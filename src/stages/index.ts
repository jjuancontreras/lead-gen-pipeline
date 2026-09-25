/**
 * Every campaign stage, in the order a run executes them.
 *
 * There is no scaffold stage: a demo is 3-5 hours of your time, so choosing
 * who gets one is a decision you make in the Work Queue, not a sort order.
 */
import type { Stage } from '../campaign-stages.ts';
import { sourceStage } from './source.ts';
import { verifyStage } from './verify.ts';
import { enrichStage } from './enrich.ts';
import { outreachStage } from './outreach.ts';

export const STAGES: readonly Stage[] = [
  sourceStage, verifyStage, enrichStage, outreachStage,
];
