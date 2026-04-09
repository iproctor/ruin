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

// Dual-head MLP: shared trunk + value head + policy head.
// `layers` describes the shared trunk plus the value head (last layer).
// `policyHead` is an additional output layer that branches off the LAST
// HIDDEN layer (i.e. the input to the value head, not the value head's output).
export interface DualHeadMlpJson {
  version: 3;
  type: 'mlp_dual';
  featureDim: number;
  actionDim: number;
  layers: LayerJson[];
  policyHead: LayerJson;
}

// Legacy v1 format for backward compat
export interface LinearJson {
  version: 1;
  featureDim: number;
  numClasses: number;
  W: number[][]; // [class][feature]
  b: number[];
}

export type ModelJson = MlpJson | DualHeadMlpJson | LinearJson;

interface CompiledLayer {
  W: Float32Array;    // flat row-major, length inDim*outDim; row i starts at i*outDim
  outDim: number;
  inDim: number;
  b: Float32Array;
  activation: Activation;
}

function compileLayer(layer: LayerJson): CompiledLayer {
  const inDim = layer.W.length;
  const outDim = layer.W[0]!.length;
  const W = new Float32Array(inDim * outDim);
  for (let i = 0; i < inDim; i++) {
    const row = layer.W[i]!;
    for (let jj = 0; jj < outDim; jj++) W[i * outDim + jj] = row[jj]!;
  }
  return { W, inDim, outDim, b: new Float32Array(layer.b), activation: layer.activation };
}

function applyLayer(input: Float32Array, layer: CompiledLayer, out: Float32Array): void {
  const { inDim, outDim, W, b } = layer;
  for (let j = 0; j < outDim; j++) out[j] = b[j]!;
  for (let i = 0; i < inDim; i++) {
    const xi = input[i]!;
    if (xi === 0) continue;
    const rowOff = i * outDim;
    for (let j = 0; j < outDim; j++) {
      out[j]! += W[rowOff + j]! * xi;
    }
  }
  if (layer.activation === 'relu') {
    for (let j = 0; j < outDim; j++) if (out[j]! < 0) out[j] = 0;
  } else if (layer.activation === 'softmax') {
    let maxv = out[0]!;
    for (let j = 1; j < outDim; j++) if (out[j]! > maxv) maxv = out[j]!;
    let s = 0;
    for (let j = 0; j < outDim; j++) { out[j] = Math.exp(out[j]! - maxv); s += out[j]!; }
    for (let j = 0; j < outDim; j++) out[j] = out[j]! / s;
  }
}

export class Mlp {
  layers: CompiledLayer[];
  policyHead: CompiledLayer | null;
  private scratchA: Float32Array;
  private scratchB: Float32Array;
  private scratchC: Float32Array;

  constructor(layers: CompiledLayer[], policyHead: CompiledLayer | null = null) {
    this.layers = layers;
    this.policyHead = policyHead;
    let maxDim = 0;
    for (const l of layers) if (l.outDim > maxDim) maxDim = l.outDim;
    if (policyHead && policyHead.outDim > maxDim) maxDim = policyHead.outDim;
    this.scratchA = new Float32Array(maxDim);
    this.scratchB = new Float32Array(maxDim);
    this.scratchC = new Float32Array(maxDim);
  }

  /** Value-only forward pass. Returns the final-layer (softmax) output. */
  forward(x: Float32Array): Float32Array {
    let input = x;
    let scratchIdx = 0;
    const scratches = [this.scratchA, this.scratchB];
    for (let li = 0; li < this.layers.length; li++) {
      const out = scratches[scratchIdx]!;
      scratchIdx ^= 1;
      applyLayer(input, this.layers[li]!, out);
      input = out;
    }
    const lastOut = this.layers[this.layers.length - 1]!.outDim;
    const result = new Float32Array(lastOut);
    for (let j = 0; j < lastOut; j++) result[j] = input[j]!;
    return result;
  }

  /**
   * Dual-head forward pass: returns both value probs and policy probs.
   * Throws if the model has no policy head loaded.
   *
   * The policy head branches off the LAST HIDDEN layer (the input to the
   * value head), so we run trunk -> last_hidden, then run two heads in
   * parallel from there.
   */
  forwardWithPolicy(x: Float32Array): { value: Float32Array; policy: Float32Array } {
    if (this.policyHead === null) {
      throw new Error('Mlp.forwardWithPolicy: no policy head loaded');
    }
    // Run all layers EXCEPT the last (which is the value head)
    let input = x;
    let scratchIdx = 0;
    const scratches = [this.scratchA, this.scratchB];
    const trunkLayers = this.layers.length - 1;
    for (let li = 0; li < trunkLayers; li++) {
      const out = scratches[scratchIdx]!;
      scratchIdx ^= 1;
      applyLayer(input, this.layers[li]!, out);
      input = out;
    }
    // input now points at the last hidden activation. Run value head into one
    // scratch, policy head into another.
    const valueHead = this.layers[trunkLayers]!;
    const valueOut = scratches[scratchIdx]!;
    applyLayer(input, valueHead, valueOut);
    const policyOut = this.scratchC;
    applyLayer(input, this.policyHead, policyOut);

    const valueResult = new Float32Array(valueHead.outDim);
    for (let j = 0; j < valueHead.outDim; j++) valueResult[j] = valueOut[j]!;
    const policyResult = new Float32Array(this.policyHead.outDim);
    for (let j = 0; j < this.policyHead.outDim; j++) policyResult[j] = policyOut[j]!;
    return { value: valueResult, policy: policyResult };
  }

  hasPolicyHead(): boolean {
    return this.policyHead !== null;
  }

  static fromJson(j: ModelJson): Mlp {
    if (j.featureDim !== FEATURE_DIM) {
      throw new Error(`Mlp: feature dim mismatch — model ${j.featureDim}, code ${FEATURE_DIM}`);
    }

    const compiled: CompiledLayer[] = [];
    let policyHead: CompiledLayer | null = null;

    const dual = j as DualHeadMlpJson;
    if (dual.version === 3 && dual.policyHead) {
      // v3 dual-head MLP
      for (const layer of dual.layers) compiled.push(compileLayer(layer));
      policyHead = compileLayer(dual.policyHead);
    } else if ((j as MlpJson).layers) {
      // v2 MLP
      for (const layer of (j as MlpJson).layers) compiled.push(compileLayer(layer));
    } else {
      // v1 linear
      const lin = j as LinearJson;
      const inDim = lin.featureDim;
      const outDim = lin.numClasses;
      const W = new Float32Array(inDim * outDim);
      for (let i = 0; i < inDim; i++) {
        for (let c = 0; c < outDim; c++) W[i * outDim + c] = lin.W[c]![i]!;
      }
      compiled.push({ W, inDim, outDim, b: new Float32Array(lin.b), activation: 'softmax' });
    }

    // Validate value head output = POWERS.length
    const last = compiled[compiled.length - 1]!;
    if (last.outDim !== POWERS.length) {
      throw new Error(`Mlp: value head output dim mismatch — model ${last.outDim}, powers ${POWERS.length}`);
    }

    return new Mlp(compiled, policyHead);
  }
}
