import { workerData, parentPort } from 'node:worker_threads';
import { runMcts } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';

const { state, power } = workerData as { state: GameState; power: Power };

try {
  const action = runMcts(state, power);
  parentPort!.postMessage({ ok: true, action });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: String(err) });
}
