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

/** bf16-trunk variants: W1/W2 are bfloat16 (upper half of fp32) as Uint16Array. */
export interface NativeMlpBf16 {
  forward: (
    W1: Uint16Array, b1: Float32Array, W2: Uint16Array, b2: Float32Array,
    Wv: Float32Array, bv: Float32Array, Wp: Float32Array | null, bp: Float32Array | null,
    input: Float32Array, h1Buf: Float32Array, h2Buf: Float32Array,
    valueOut: Float32Array, policyOut: Float32Array | null,
    inDim: number, h1: number, h2: number, valueDim: number, policyDim: number,
  ) => void;
  valueOnly: (
    W1: Uint16Array, b1: Float32Array, W2: Uint16Array, b2: Float32Array,
    Wv: Float32Array, bv: Float32Array, input: Float32Array,
    h1Buf: Float32Array, h2Buf: Float32Array, valueOut: Float32Array,
    inDim: number, h1: number, h2: number, valueDim: number,
  ) => number;
}

let cached: NativeMlpForward | null | undefined = undefined;
let cachedBf16: NativeMlpBf16 | null | undefined = undefined;
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
  if (process.env.RUIN_DISABLE_NATIVE === '1') {
    cached = null;
    cachedValueOnly = null;
    return null;
  }
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
    try {
      const fwd16 = lib.func('void mlp_forward_bf16(uint16_t*, float*, uint16_t*, float*, float*, float*, float*, float*, float*, float*, float*, float*, float*, int, int, int, int, int)');
      const val16 = lib.func('float mlp_value_only_bf16(uint16_t*, float*, uint16_t*, float*, float*, float*, float*, float*, float*, float*, int, int, int, int)');
      cachedBf16 = { forward: fwd16, valueOnly: val16 } as NativeMlpBf16;
    } catch {
      cachedBf16 = null; // older libmlp without bf16 symbols
    }
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

/**
 * bf16 trunk entry points, or null when disabled / unavailable. Opt-in via
 * RUIN_MLP_BF16=1 so the fp32 path stays the default until benched.
 */
export function loadNativeMlpBf16(): NativeMlpBf16 | null {
  if (process.env.RUIN_MLP_BF16 !== '1') return null;
  if (cached === undefined) loadNativeMlp();
  return cachedBf16 ?? null;
}

/** fp32 → bfloat16 with round-to-nearest-even (NaN-safe enough for weights). */
export function toBf16(src: Float32Array): Uint16Array {
  const u32 = new Uint32Array(src.buffer, src.byteOffset, src.length);
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const u = u32[i]!;
    out[i] = ((u + 0x7fff + ((u >>> 16) & 1)) >>> 16) & 0xffff;
  }
  return out;
}
