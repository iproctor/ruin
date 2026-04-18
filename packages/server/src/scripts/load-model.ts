/**
 * Shared bootstrap: if packages/ai/data/model.json exists, load it into the
 * AI package so evaluateState uses the learned evaluator. Otherwise silently
 * do nothing (hand-tuned evaluator remains active).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mlp, loadModel, loadModelForPower, type ModelJson } from '@ruin/ai';
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
      if (Mlp.isBundle(j)) {
        const bundle = Mlp.fromBundle(j);
        let first = true;
        for (const [power, mlp] of bundle) {
          if (first) { loadModel(j.models[power]!); first = false; }
          loadModelForPower(power as Power, j.models[power]!);
        }
        console.log(`[ai] loaded v5 per-power bundle: ${p} (${bundle.size} powers)`);
      } else {
        loadModel(j);
        console.log(`[ai] loaded learned model: ${p}`);
      }
      return true;
    }
  }
  if (explicitPath) {
    throw new Error(`[ai] model not found: ${explicitPath}`);
  }
  return false;
}
