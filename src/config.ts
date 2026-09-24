import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { settings } from './settings.ts';  // loads .env.local and validates it
import type { Bbox } from './overpass.ts';

export const ROOT = settings().root;
export const configPath = (name: string) => resolve(ROOT, 'config', name);
/** Under PIPELINE_DATA_DIR, so a test or dry run never lands in the real data. */
export const dataPath = (name: string) => resolve(settings().dataDir, name);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface AreasConfig {
  chainIndexBbox: Bbox;
  chainIndexLabel: string;
  areas: Record<string, { label: string; bbox: Bbox }>;
}

export interface CategoryDef { label: string; phase: number; weight: number }

export interface CategoriesConfig {
  categories: Record<string, CategoryDef>;
  sme: {
    chainCutoff: number;
    multiBranchBonusMin: number;
    multiBranchBonusMax: number;
    floor: { minReviewCount: number; minPhotoCount: number; minIgFollowers: number };
    ceiling: { maxReviewCount: number; maxIgFollowers: number };
  };
}

export interface ChainIndex {
  generatedAt: string;
  bbox: Bbox;
  label: string;
  totalPois: number;
  distinctNames: number;
  /** Only names with 2+ locations are stored; absent means 1. */
  counts: Record<string, number>;
  examples: Record<string, string[]>;
}

export const loadAreas = () => readJson<AreasConfig>(configPath('areas.json'));
export const loadCategories = () => readJson<CategoriesConfig>(configPath('categories.json'));
export const loadManualChains = () =>
  readJson<{ denylist: string[] }>(configPath('chains-manual.json'));

export function loadChainIndex(): ChainIndex | null {
  const p = configPath('chain-index.json');
  return existsSync(p) ? readJson<ChainIndex>(p) : null;
}

/** Category keys ("amenity=cafe") enabled for a given phase and below. */
export function categoryKeysForPhase(cfg: CategoriesConfig, maxPhase: number): string[] {
  return Object.entries(cfg.categories)
    .filter(([, def]) => def.phase <= maxPhase)
    .map(([key]) => key);
}
