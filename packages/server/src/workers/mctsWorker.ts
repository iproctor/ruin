import { workerData, parentPort } from 'node:worker_threads';
import { runMcts } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';
import { loadLearnedModelIfPresent } from '../scripts/load-model.js';

// Worker threads don't share module-level state with the parent — each one
// must load the model into its own memory or MCTS falls back to the hand-tuned
// heuristic and produces low-quality plays.
loadLearnedModelIfPresent();

const { state, power } = workerData as { state: GameState; power: Power };

try {
  const action = runMcts(state, power);
  parentPort!.postMessage({ ok: true, action });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: String(err) });
}
