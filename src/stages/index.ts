/** Every campaign stage, in the order a run executes them. */
import type { Stage } from '../campaign-stages.ts';
import { sourceStage } from './source.ts';
import { verifyStage } from './verify.ts';
import { enrichStage } from './enrich.ts';
import { scaffoldStage } from './scaffold.ts';
import { outreachStage } from './outreach.ts';

export const STAGES: readonly Stage[] = [
  sourceStage, verifyStage, enrichStage, scaffoldStage, outreachStage,
];
