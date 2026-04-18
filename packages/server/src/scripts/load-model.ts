/**
 * Shared bootstrap: if packages/ai/data/model.json exists, load it into the
 * AI package so evaluateState uses the learned evaluator. Otherwise silently
 * do nothing (hand-tuned evaluator remains active).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadModel, loadModelForPower, type ModelJson } from '@ruin/ai';
import type { Power } from '@ruin/engine';

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

      // Load per-power models if available (separate policy heads per power).
      const dir = path.dirname(p);
      const powers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
      let perPowerCount = 0;
      for (const power of powers) {
        const pp = path.join(dir, `model_${power}.json`);
        if (fs.existsSync(pp)) {
          loadModelForPower(power, JSON.parse(fs.readFileSync(pp, 'utf-8')) as ModelJson);
          perPowerCount++;
        }
      }
      if (perPowerCount > 0) {
        console.log(`[ai] loaded ${perPowerCount} per-power models`);
      }
      return true;
    }
  }
  if (explicitPath) {
    throw new Error(`[ai] model not found: ${explicitPath}`);
  }
  return false;
}
