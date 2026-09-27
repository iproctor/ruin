#!/usr/bin/env node
// Convert raw generated PNGs (art-src/) into web-sized webp (src/assets/art/).
// Requires `cwebp` on PATH. Skips outputs newer than their source.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../art-src');
const DST = path.resolve(here, '../../src/assets/art');

// [width, height, quality] per kind; 0 height keeps aspect.
const SIZES = {
  cards: [480, 0, 76],
  upgrades: [480, 0, 76],
  world: [480, 0, 76],
  gods: [600, 0, 78],
  followers: [256, 0, 80],
  tokens: [160, 0, 82],
  regions: [960, 0, 74],
  misc: [1600, 0, 70],
};

let n = 0;
for (const kind of Object.keys(SIZES)) {
  const dir = path.join(SRC, kind);
  if (!existsSync(dir)) continue;
  mkdirSync(path.join(DST, kind), { recursive: true });
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.png')) continue;
    const src = path.join(dir, f);
    const out = path.join(DST, kind, f.replace(/\.png$/, '.webp'));
    if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) continue;
    const [w, h, q] = kind === 'misc' && f.startsWith('card_back') ? [480, 0, 78] : SIZES[kind];
    execFileSync('cwebp', ['-quiet', '-q', String(q), '-resize', String(w), String(h), src, '-o', out]);
    n++;
  }
}
console.log(`processed ${n} images`);
