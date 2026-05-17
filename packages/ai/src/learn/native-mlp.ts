/**
 * Lazy loader for the native libmlp shared library. Returns a `forward`
 * function that mirrors Mlp.forwardWithPolicy / forward but runs in C.
 * If koffi or libmlp can't be loaded, returns null and callers fall back
 * to the pure-JS implementation in mlp.ts.
 *
 * Build: `make -C packages/ai/native` produces libmlp.{dylib,so} in the
 * native/ directory. The path is resolved relative to this file's URL,
 * so the lookup works regardless of CWD.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export interface NativeMlpForward {
  /** value buffer is the caller-allocated output for the value head. */
  (
    W1: Float32Array, b1: Float32Array,
    W2: Float32Array, b2: Float32Array,
    Wv: Float32Array, bv: Float32Array,
    Wp: Float32Array | null, bp: Float32Array | null,
    input: Float32Array,
    h1Buf: Float32Array, h2Buf: Float32Array,
    valueOut: Float32Array,
    policyOut: Float32Array | null,
    inDim: number, h1: number, h2: number, valueDim: number, policyDim: number,
  ): void;
}

export interface NativeMlpValueOnly {
  (
    W1: Float32Array, b1: Float32Array,
    W2: Float32Array, b2: Float32Array,
    Wv: Float32Array, bv: Float32Array,
    input: Float32Array,
    h1Buf: Float32Array, h2Buf: Float32Array,
    valueOut: Float32Array,
    inDim: number, h1: number, h2: number, valueDim: number,
  ): number;
}

let cached: NativeMlpForward | null | undefined = undefined;
let cachedValueOnly: NativeMlpValueOnly | null | undefined = undefined;

function findLibPath(): string | null {
  // Walk up from this file's directory until we find packages/ai/native/libmlp.*
  let dir: string;
  try { dir = path.dirname(fileURLToPath(import.meta.url)); }
  catch { return null; }
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'packages/ai/native', `libmlp.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
    const local = path.join(dir, '..', '..', 'native', `libmlp.${ext}`);
    if (fs.existsSync(local)) return local;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the native library. Returns the bound function on success, null on
 * failure (dynamic import of koffi failed, or the .dylib/.so is missing).
 * Result is cached so repeated calls are cheap.
 */
export function loadNativeMlp(): NativeMlpForward | null {
  if (cached !== undefined) return cached;
  const libPath = findLibPath();
  if (libPath === null) {
    cached = null;
    return null;
  }
  try {
    // Sync CJS require for koffi resolved from this module's location, so
    // package resolution finds packages/ai/node_modules/koffi (or the pnpm
    // store via the symlink chain).
    const requireFn = createRequire(import.meta.url);
    const koffi = requireFn('koffi');
    const lib = koffi.load(libPath);
    const fn = lib.func('void mlp_forward(float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, int, int, int, int, int)');
    const valueFn = lib.func('float mlp_value_only(float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, int, int, int, int)');
    cached = ((W1, b1, W2, b2, Wv, bv, Wp, bp, input, h1Buf, h2Buf, valueOut, policyOut, inDim, h1, h2, valueDim, policyDim) => {
      fn(W1, b1, W2, b2, Wv, bv, Wp, bp, input, h1Buf, h2Buf, valueOut, policyOut, inDim, h1, h2, valueDim, policyDim);
    }) as NativeMlpForward;
    cachedValueOnly = ((W1, b1, W2, b2, Wv, bv, input, h1Buf, h2Buf, valueOut, inDim, h1, h2, valueDim) =>
      valueFn(W1, b1, W2, b2, Wv, bv, input, h1Buf, h2Buf, valueOut, inDim, h1, h2, valueDim)
    ) as NativeMlpValueOnly;
    console.log(`[ai] native MLP loaded: ${libPath}`);
    return cached;
  } catch (err) {
    console.warn(`[ai] native MLP load failed (falling back to JS): ${err instanceof Error ? err.message : String(err)}`);
    cached = null;
    cachedValueOnly = null;
    return null;
  }
}

export function loadNativeMlpValueOnly(): NativeMlpValueOnly | null {
  if (cachedValueOnly !== undefined) return cachedValueOnly;
  if (cached === undefined) loadNativeMlp();
  return cachedValueOnly ?? null;
}
