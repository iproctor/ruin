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

type Activation = 'relu' | 'softmax' | 'linear' | 'sigmoid';

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
// Either:
//   - `policyHead`: a single output layer branching off the LAST HIDDEN layer
//     (legacy: trunk_a2 -> Wp -> softmax)
//   - `policyLayers`: a list of layers applied in sequence from the last
//     hidden activation. Lets the policy branch carry its own ReLU hidden
//     layer (trunk_a2 -> Wph -> ReLU -> Wp -> softmax).
export interface DualHeadMlpJson {
  version: 3;
  type: 'mlp_dual';
  featureDim: number;
  actionDim: number;
  layers: LayerJson[];
  policyHead?: LayerJson;
  policyLayers?: LayerJson[];
}

// v4: shared trunk + value head + per-power policy heads.
// Each power has its own policy head so policy gradients don't interfere
// across powers. The shared trunk and value head are identical to v3.
export interface MultiPolicyMlpJson {
  version: 4;
  type: 'mlp_multi_policy';
  featureDim: number;
  actionDim: number;
  layers: LayerJson[];
  policyHeads: Record<string, LayerJson>;  // keyed by power name
}

// v5: per-power bundle — 4 independent v3 models in one file.
// Each power has its own trunk + value + policy head.
export interface PerPowerBundleJson {
  version: 5;
  type: 'per_power_bundle';
  featureDim: number;
  actionDim: number;
  iter?: number;
  models: Record<string, DualHeadMlpJson>;
}

// Legacy v1 format for backward compat
export interface LinearJson {
  version: 1;
  featureDim: number;
  numClasses: number;
  W: number[][]; // [class][feature]
  b: number[];
}

export type ModelJson = MlpJson | DualHeadMlpJson | MultiPolicyMlpJson | PerPowerBundleJson | LinearJson;

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
  } else if (layer.activation === 'sigmoid') {
    for (let j = 0; j < outDim; j++) out[j] = 1 / (1 + Math.exp(-out[j]!));
  }
}

export class Mlp {
  layers: CompiledLayer[];
  // Policy branch (applied in order from last-hidden activation). Empty = no
  // policy head loaded. One entry = legacy single-projection. Two+ entries =
  // hidden + projection.
  policyChain: CompiledLayer[];
  perPowerPolicyHeads: Map<string, CompiledLayer> | null;
  private scratchA: Float32Array;
  private scratchB: Float32Array;
  private scratchC: Float32Array;
  private scratchD: Float32Array;

  constructor(
    layers: CompiledLayer[],
    policyChain: CompiledLayer[] = [],
    perPowerPolicyHeads: Map<string, CompiledLayer> | null = null,
  ) {
    this.layers = layers;
    this.policyChain = policyChain;
    this.perPowerPolicyHeads = perPowerPolicyHeads;
    let maxDim = 0;
    for (const l of layers) if (l.outDim > maxDim) maxDim = l.outDim;
    for (const l of policyChain) if (l.outDim > maxDim) maxDim = l.outDim;
    if (perPowerPolicyHeads) {
      for (const h of perPowerPolicyHeads.values()) if (h.outDim > maxDim) maxDim = h.outDim;
    }
    this.scratchA = new Float32Array(maxDim);
    this.scratchB = new Float32Array(maxDim);
    this.scratchC = new Float32Array(maxDim);
    this.scratchD = new Float32Array(maxDim);
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
   *
   * When per-power policy heads are available and `power` is given, uses
   * that power's dedicated head. Falls back to the shared head otherwise.
   */
  forwardWithPolicy(x: Float32Array, power?: string): { value: Float32Array; policy: Float32Array } {
    // Per-power policy head still uses the legacy single-layer path.
    const perPower = power !== undefined ? this.perPowerPolicyHeads?.get(power) : undefined;
    const useChain = perPower === undefined && this.policyChain.length > 0;
    if (perPower === undefined && this.policyChain.length === 0) {
      throw new Error('Mlp.forwardWithPolicy: no policy head loaded');
    }
    // Run trunk: all layers EXCEPT the last (which is the value head).
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
    // `input` is now the last-hidden activation. Run value head.
    const valueHead = this.layers[trunkLayers]!;
    const valueOut = scratches[scratchIdx]!;
    applyLayer(input, valueHead, valueOut);

    // Policy: either chain (one or more layers) or single per-power head.
    let policyOut: Float32Array;
    let policyOutDim: number;
    if (useChain) {
      const polScratches = [this.scratchC, this.scratchD];
      let polInput = input;
      let polIdx = 0;
      for (let li = 0; li < this.policyChain.length; li++) {
        const out = polScratches[polIdx]!;
        polIdx ^= 1;
        applyLayer(polInput, this.policyChain[li]!, out);
        polInput = out;
      }
      policyOut = polInput;
      policyOutDim = this.policyChain[this.policyChain.length - 1]!.outDim;
    } else {
      policyOut = this.scratchC;
      applyLayer(input, perPower!, policyOut);
      policyOutDim = perPower!.outDim;
    }

    const valueResult = new Float32Array(valueHead.outDim);
    for (let j = 0; j < valueHead.outDim; j++) valueResult[j] = valueOut[j]!;
    const policyResult = new Float32Array(policyOutDim);
    for (let j = 0; j < policyOutDim; j++) policyResult[j] = policyOut[j]!;
    return { value: valueResult, policy: policyResult };
  }

  hasPolicyHead(): boolean {
    return this.policyChain.length > 0 || (this.perPowerPolicyHeads !== null && this.perPowerPolicyHeads.size > 0);
  }

  /** Returns true if `j` is a v5 per-power bundle (needs special handling). */
  static isBundle(j: ModelJson): j is PerPowerBundleJson {
    return (j as PerPowerBundleJson).version === 5;
  }

  /** Load a v5 bundle: returns a Map of power → Mlp. */
  static fromBundle(j: PerPowerBundleJson): Map<string, Mlp> {
    const result = new Map<string, Mlp>();
    for (const [power, sub] of Object.entries(j.models)) {
      result.set(power, Mlp.fromJson(sub));
    }
    return result;
  }

  static fromJson(j: ModelJson): Mlp {
    if (Mlp.isBundle(j)) {
      // For callers that expect a single Mlp, return the first power's model.
      const first = Object.values(j.models)[0]!;
      return Mlp.fromJson(first);
    }

    // Allow older models (smaller featureDim) to load by zero-padding the
    // first layer's W1 rows for the new feature positions. New features then
    // contribute nothing to the output until training updates those rows.
    // This keeps feature additions append-only AND keeps old checkpoints
    // usable during the transition.
    const oldFeatureDim = j.featureDim;
    if (oldFeatureDim > FEATURE_DIM) {
      throw new Error(`Mlp: model featureDim ${oldFeatureDim} > code ${FEATURE_DIM} — can't shrink`);
    }

    const compiled: CompiledLayer[] = [];
    const policyChain: CompiledLayer[] = [];
    let perPowerPolicyHeads: Map<string, CompiledLayer> | null = null;

    // Patch any layer whose inDim == oldFeatureDim < FEATURE_DIM by appending
    // zero rows to reach FEATURE_DIM. Only W1 (the first trunk layer) actually
    // consumes the input vector, but pad any matching layer for safety.
    const padLayer = (layer: LayerJson): LayerJson => {
      const inDim = layer.W.length;
      if (inDim === oldFeatureDim && inDim < FEATURE_DIM) {
        const outDim = layer.W[0]!.length;
        const padded: number[][] = layer.W.map(row => row);
        for (let pad = inDim; pad < FEATURE_DIM; pad++) {
          padded.push(new Array(outDim).fill(0));
        }
        return { ...layer, W: padded };
      }
      return layer;
    };

    const multi = j as MultiPolicyMlpJson;
    const dual = j as DualHeadMlpJson;
    if (multi.version === 4 && multi.policyHeads) {
      for (const layer of multi.layers) compiled.push(compileLayer(padLayer(layer)));
      perPowerPolicyHeads = new Map();
      for (const [power, head] of Object.entries(multi.policyHeads)) {
        perPowerPolicyHeads.set(power, compileLayer(head));
      }
    } else if (dual.version === 3 && (dual.policyHead || dual.policyLayers)) {
      for (const layer of dual.layers) compiled.push(compileLayer(padLayer(layer)));
      if (dual.policyLayers && dual.policyLayers.length > 0) {
        for (const layer of dual.policyLayers) policyChain.push(compileLayer(layer));
      } else if (dual.policyHead) {
        policyChain.push(compileLayer(dual.policyHead));
      }
    } else if ((j as MlpJson).layers) {
      // v2 MLP
      for (const layer of (j as MlpJson).layers) compiled.push(compileLayer(padLayer(layer)));
    } else {
      // v1 linear — skip pad (unlikely to encounter during this transition)
      const lin = j as LinearJson;
      const inDim = lin.featureDim;
      const outDim = lin.numClasses;
      const W = new Float32Array(inDim * outDim);
      for (let i = 0; i < inDim; i++) {
        for (let c = 0; c < outDim; c++) W[i * outDim + c] = lin.W[c]![i]!;
      }
      compiled.push({ W, inDim, outDim, b: new Float32Array(lin.b), activation: 'softmax' });
    }

    // Validate value head output: either POWERS.length (full 4-way softmax)
    // or 1 (scalar P(viewpoint wins), for focus-trained models). The scalar
    // form uses sigmoid activation; the 4-way uses softmax.
    const last = compiled[compiled.length - 1]!;
    if (last.outDim !== POWERS.length && last.outDim !== 1) {
      throw new Error(`Mlp: value head output dim ${last.outDim} is neither ${POWERS.length} (multi-power) nor 1 (scalar)`);
    }

    return new Mlp(compiled, policyChain, perPowerPolicyHeads);
  }
}
