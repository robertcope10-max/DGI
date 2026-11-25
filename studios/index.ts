/**
 * Studio registry. Adding a studio = add a folder with studio.ts and one line here.
 * (`npm run studio:new` does both.)
 */
import type { StudioDefinition } from '@dgi/core';
import policy from './policy/studio.ts';
import qc from './qc/studio.ts';

export const studios: StudioDefinition[] = [
  policy,
  qc,
  // studio:new inserts here
];
