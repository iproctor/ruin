// Time Mlp.forwardValue on a realistic sparse input; argv[2] = model path.
import { readFileSync } from 'node:fs';
import { Mlp } from '../dist/learn/mlp.js';
const json = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const mlp = Mlp.fromJson(json);
const x = new Float32Array(json.featureDim);
for (let i = 0; i < x.length; i++) if (Math.random() < 0.2) x[i] = Math.random();
let s = 0; const N = 20000;
for (let i = 0; i < 500; i++) s += mlp.forwardValue(x, 0);
const t = process.hrtime.bigint();
for (let i = 0; i < N; i++) { x[i % x.length] = (i & 1); s += mlp.forwardValue(x, 0); }
const us = Number(process.hrtime.bigint() - t) / 1e3 / N;
const h1 = json.layers[0].W[0].length, h2 = json.layers[1].W[0].length;
console.log(`${process.argv[2].split('/').pop()} h1=${h1} h2=${h2}: ${us.toFixed(1)} us/forward  (weights ${(json.featureDim*h1+h1*h2)*4/1e6|0}MB)`);
