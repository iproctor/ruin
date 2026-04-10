/**
 * Shared bootstrap: if packages/ai/data/model.json exists, load it into the
 * AI package so evaluateState uses the learned evaluator. Otherwise silently
 * do nothing (hand-tuned evaluator remains active).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadModel, type ModelJson } from '@ruin/ai';

export function loadLearnedModelIfPresent(explicitPath?: string): boolean {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [
      path.resolve('packages/ai/data/model.json'),
      path.resolve(process.cwd(), 'packages/ai/data/model.json'),
    ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as ModelJson;
      loadModel(j);
      // eslint-disable-next-line no-console
      console.log(`[ai] loaded learned model: ${p}`);
      return true;
    }
  }
  if (explicitPath) {
    throw new Error(`[ai] model not found: ${explicitPath}`);
  }
  return false;
}
