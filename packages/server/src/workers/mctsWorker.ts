import { workerData, parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcts, Mlp, loadModel, loadModelForPower, type ModelJson } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';

// Worker threads don't share module-level state with the parent — each one
// must load the model into its own memory or MCTS falls back to the hand-tuned
// heuristic and produces low-quality plays. Inlined here (vs importing from
// scripts/load-model) because the worker is loaded via Worker URL with TS/JS
// extension switching that doesn't compose with relative imports across modes.
function loadModelHere(): void {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  let modelPath: string | null = null;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'packages/ai/data/model.json');
    if (fs.existsSync(candidate)) { modelPath = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!modelPath) return;
  const j = JSON.parse(fs.readFileSync(modelPath, 'utf-8')) as ModelJson;
  if (Mlp.isBundle(j)) {
    const bundle = Mlp.fromBundle(j);
    let first = true;
    for (const [power] of bundle) {
      if (first) { loadModel(j.models[power]!); first = false; }
      loadModelForPower(power as Power, j.models[power]!);
    }
  } else {
    loadModel(j);
  }
  const modelDir = path.dirname(modelPath);
  for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
    const ppath = path.join(modelDir, `model_${power}.json`);
    if (fs.existsSync(ppath)) {
      const pj = JSON.parse(fs.readFileSync(ppath, 'utf-8')) as ModelJson;
      loadModelForPower(power, pj);
    }
  }
}
loadModelHere();

const { state, power } = workerData as { state: GameState; power: Power };

try {
  const action = runMcts(state, power);
  parentPort!.postMessage({ ok: true, action });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: String(err) });
}
