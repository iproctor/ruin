// Benchmark native C MLP vs current Mlp on 10000 forward passes.
// Usage:
//   make -C packages/ai/native
//   node packages/ai/native/bench_native.mjs

import koffi from 'koffi';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Mlp } from '../dist/learn/mlp.js';

const dir = dirname(fileURLToPath(import.meta.url));
const lib = koffi.load(join(dir, process.platform === 'darwin' ? 'libmlp.dylib' : 'libmlp.so'));

// Pointer types — using Float32Array buffers.
const f32p = koffi.pointer('float');

const mlpForward = lib.func('int mlp_forward(float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, int, int, int, int, int)');

// Load model
const modelPath = process.argv[2] ?? 'packages/ai/data/model_xarm.json';
const json = JSON.parse(readFileSync(modelPath, 'utf-8'));
const mlp = Mlp.fromJson(json);

const featDim = json.featureDim;

// Pull weights as flat Float32Arrays. The JSON format stores them as nested
// arrays — flatten row-major.
function flatten2d(rows) {
  const r = rows.length, c = rows[0].length;
  const out = new Float32Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[i * c + j] = rows[i][j];
  return { data: out, rows: r, cols: c };
}

const W1 = flatten2d(json.layers[0].W);
const b1 = new Float32Array(json.layers[0].b);
const W2 = flatten2d(json.layers[1].W);
const b2 = new Float32Array(json.layers[1].b);
const Wv = flatten2d(json.layers[2].W);
const bv = new Float32Array(json.layers[2].b);
const Wp = flatten2d(json.policyHead.W);
const bp = new Float32Array(json.policyHead.b);

const h1 = W1.cols;
const h2 = W2.cols;
const valueDim = Wv.cols;
const policyDim = Wp.cols;

console.log(`Model: in=${featDim}  h1=${h1}  h2=${h2}  v=${valueDim}  p=${policyDim}`);

// Pre-allocated scratch + output buffers
const h1Buf = new Float32Array(h1);
const h2Buf = new Float32Array(h2);
const valueOut = new Float32Array(valueDim);
const policyOut = new Float32Array(policyDim);

// Random sparse input
const x = new Float32Array(featDim);
for (let i = 0; i < featDim; i++) x[i] = Math.random() < 0.3 ? Math.random() : 0;

// Warmup
mlpForward(W1.data, b1, W2.data, b2, Wv.data, bv, Wp.data, bp, x, h1Buf, h2Buf, valueOut, policyOut, featDim, h1, h2, valueDim, policyDim);
mlp.forwardWithPolicy(x, 'xarm');

// Numerical check
const tsResult = mlp.forwardWithPolicy(x, 'xarm');
console.log(`numerical check: TS value=${tsResult.value[0].toFixed(6)} native=${valueOut[0].toFixed(6)} diff=${Math.abs(tsResult.value[0] - valueOut[0]).toExponential(2)}`);
console.log(`                 TS policy[0]=${tsResult.policy[0].toFixed(6)} native=${policyOut[0].toFixed(6)} diff=${Math.abs(tsResult.policy[0] - policyOut[0]).toExponential(2)}`);

const N = 10000;

// JS Mlp baseline
const t0 = process.hrtime.bigint();
let acc = 0;
for (let i = 0; i < N; i++) {
  const r = mlp.forwardWithPolicy(x, 'xarm');
  acc += r.value[0] + r.policy[0];
}
const tMlp = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`Mlp:    ${tMlp.toFixed(0)}ms  (${(tMlp / N * 1000).toFixed(1)}µs/call)  acc=${acc.toFixed(2)}`);

// Native
const t1 = process.hrtime.bigint();
let accN = 0;
for (let i = 0; i < N; i++) {
  mlpForward(W1.data, b1, W2.data, b2, Wv.data, bv, Wp.data, bp, x, h1Buf, h2Buf, valueOut, policyOut, featDim, h1, h2, valueDim, policyDim);
  accN += valueOut[0] + policyOut[0];
}
const tNative = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(`Native: ${tNative.toFixed(0)}ms  (${(tNative / N * 1000).toFixed(1)}µs/call)  acc=${accN.toFixed(2)}`);

console.log(`Speedup: ${(tMlp / tNative).toFixed(2)}×`);
