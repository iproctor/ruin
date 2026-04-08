import { FEATURE_DIM, POWERS } from './features.js';

/**
 * MLP inference (pure TS, single-example forward pass).
 *
 * Compatible with both:
 *   - v2 MLP JSON produced by scripts/train_mlp.py (layers list)
 *   - v1 linear JSON produced by the old TS trainer (W/b flat)
 *
 * Only forward is implemented. Training lives in Python.
 */

type Activation = 'relu' | 'softmax' | 'linear';

interface LayerJson {
  // Row-major: W[i_in][j_out] — Python's numpy .tolist() on (in, out) shape
  W: number[][];
  b: number[];
  activation: Activation;
}

export interface MlpJson {
  version: 2;
  type: 'mlp';
  featureDim: number;
  layers: LayerJson[];
}

// Legacy v1 format for backward compat
export interface LinearJson {
  version: 1;
  featureDim: number;
  numClasses: number;
  W: number[][]; // [class][feature]
  b: number[];
}

export type ModelJson = MlpJson | LinearJson;

interface CompiledLayer {
  W: Float32Array;    // flat row-major, length inDim*outDim; row i starts at i*outDim
  outDim: number;
  inDim: number;
  b: Float32Array;
  activation: Activation;
}

export class Mlp {
  layers: CompiledLayer[];
  private scratchA: Float32Array;
  private scratchB: Float32Array;

  constructor(layers: CompiledLayer[]) {
    this.layers = layers;
    let maxDim = 0;
    for (const l of layers) if (l.outDim > maxDim) maxDim = l.outDim;
    this.scratchA = new Float32Array(maxDim);
    this.scratchB = new Float32Array(maxDim);
  }

  forward(x: Float32Array): Float32Array {
    let input = x;
    let scratchIdx = 0;
    const scratches = [this.scratchA, this.scratchB];
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]!;
      const inDim = layer.inDim;
      const outDim = layer.outDim;
      const W = layer.W;
      const b = layer.b;
      const out = scratches[scratchIdx]!;
      scratchIdx ^= 1;
      // Initialize out with bias.
      for (let j = 0; j < outDim; j++) out[j] = b[j]!;
      // out += W^T · input  (W is row-major in × out, row i at offset i*outDim).
      for (let i = 0; i < inDim; i++) {
        const xi = input[i]!;
        if (xi === 0) continue; // mild sparsity optimisation
        const rowOff = i * outDim;
        for (let j = 0; j < outDim; j++) {
          out[j]! += W[rowOff + j]! * xi;
        }
      }
      // Activation
      if (layer.activation === 'relu') {
        for (let j = 0; j < outDim; j++) {
          if (out[j]! < 0) out[j] = 0;
        }
      } else if (layer.activation === 'softmax') {
        let maxv = out[0]!;
        for (let j = 1; j < outDim; j++) if (out[j]! > maxv) maxv = out[j]!;
        let s = 0;
        for (let j = 0; j < outDim; j++) { out[j] = Math.exp(out[j]! - maxv); s += out[j]!; }
        for (let j = 0; j < outDim; j++) out[j] = out[j]! / s;
      }
      input = out;
    }
    // Return a right-sized copy so callers can retain the result without it
    // being clobbered by a subsequent forward() call.
    const lastOut = this.layers[this.layers.length - 1]!.outDim;
    const result = new Float32Array(lastOut);
    for (let j = 0; j < lastOut; j++) result[j] = input[j]!;
    return result;
  }

  static fromJson(j: ModelJson): Mlp {
    if (j.featureDim !== FEATURE_DIM) {
      throw new Error(`Mlp: feature dim mismatch — model ${j.featureDim}, code ${FEATURE_DIM}`);
    }

    const compiled: CompiledLayer[] = [];

    if ((j as MlpJson).layers) {
      // v2 MLP
      for (const layer of (j as MlpJson).layers) {
        const inDim = layer.W.length;
        const outDim = layer.W[0]!.length;
        const W = new Float32Array(inDim * outDim);
        for (let i = 0; i < inDim; i++) {
          const row = layer.W[i]!;
          for (let jj = 0; jj < outDim; jj++) W[i * outDim + jj] = row[jj]!;
        }
        compiled.push({ W, inDim, outDim, b: new Float32Array(layer.b), activation: layer.activation });
      }
    } else {
      // v1 linear: single softmax layer, W stored as [class][feature]
      const lin = j as LinearJson;
      const inDim = lin.featureDim;
      const outDim = lin.numClasses;
      const W = new Float32Array(inDim * outDim);
      for (let i = 0; i < inDim; i++) {
        for (let c = 0; c < outDim; c++) W[i * outDim + c] = lin.W[c]![i]!;
      }
      compiled.push({ W, inDim, outDim, b: new Float32Array(lin.b), activation: 'softmax' });
    }

    // Validate final output = POWERS.length
    const last = compiled[compiled.length - 1]!;
    if (last.outDim !== POWERS.length) {
      throw new Error(`Mlp: output dim mismatch — model ${last.outDim}, powers ${POWERS.length}`);
    }

    return new Mlp(compiled);
  }
}
