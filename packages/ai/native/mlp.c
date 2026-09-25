/*
 * Native MLP forward pass for the value + policy heads.
 *
 * The model is a small feed-forward net: input → Linear+ReLU → Linear+ReLU
 * → branches to value (Linear+sigmoid) and policy (Linear+softmax).
 *
 * Weight matrices are stored row-major as flat float arrays:
 *   W1: (in_dim, h1)     b1: (h1)
 *   W2: (h1, h2)         b2: (h2)
 *   Wv: (h2, value_dim)  bv: (value_dim)
 *   Wp: (h2, policy_dim) bp: (policy_dim)
 *
 * Compile (macOS):
 *   clang -O3 -ffast-math -fPIC -shared -o libmlp.dylib mlp.c
 * Compile (Linux):
 *   gcc -O3 -ffast-math -fPIC -shared -o libmlp.so mlp.c
 *
 * Caller manages buffers — the library is stateless.
 */

#include <stdint.h>
#include <math.h>
#include <string.h>

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

/*
 * out = relu(input @ W + b)
 *   input: (in_dim,)         W: (in_dim, out_dim)         b: (out_dim,)
 *   out:   (out_dim,)
 *
 * Loop ordering puts in_dim outer (since most of `input` is 0 — features are
 * sparse-ish — early-out on input==0 cuts ~30% of the multiplies). Inner loop
 * is contiguous over W's row, enabling auto-vectorization.
 */
static inline void linear_relu(
    const float* __restrict input,
    const float* __restrict W,
    const float* __restrict b,
    float* __restrict out,
    int in_dim,
    int out_dim
) {
  memcpy(out, b, sizeof(float) * (size_t)out_dim);
  for (int i = 0; i < in_dim; i++) {
    const float xi = input[i];
    if (xi == 0.0f) continue;
    const float* row = W + (size_t)i * out_dim;
    for (int j = 0; j < out_dim; j++) {
      out[j] += row[j] * xi;
    }
  }
  for (int j = 0; j < out_dim; j++) {
    if (out[j] < 0.0f) out[j] = 0.0f;
  }
}

/* out = input @ W + b (no activation). Same loop structure as linear_relu. */
static inline void linear(
    const float* __restrict input,
    const float* __restrict W,
    const float* __restrict b,
    float* __restrict out,
    int in_dim,
    int out_dim
) {
  memcpy(out, b, sizeof(float) * (size_t)out_dim);
  for (int i = 0; i < in_dim; i++) {
    const float xi = input[i];
    if (xi == 0.0f) continue;
    const float* row = W + (size_t)i * out_dim;
    for (int j = 0; j < out_dim; j++) {
      out[j] += row[j] * xi;
    }
  }
}

/*
 * bfloat16 variants of the trunk layers. Weights are stored as the upper 16
 * bits of the fp32 value (round-to-nearest-even at load time on the JS side),
 * so widening back to fp32 is a 16-bit shift. Halves the bytes streamed per
 * forward; MCTS is memory-bandwidth bound once many processes share a box,
 * so this is close to a 2x throughput win. Accumulation stays fp32.
 */
static inline float bf16_to_f32(uint16_t h) {
  uint32_t u = (uint32_t)h << 16;
  float f;
  memcpy(&f, &u, sizeof f);
  return f;
}

static inline void linear_relu_bf16(
    const float* __restrict input,
    const uint16_t* __restrict W,
    const float* __restrict b,
    float* __restrict out,
    int in_dim,
    int out_dim
) {
  memcpy(out, b, sizeof(float) * (size_t)out_dim);
  for (int i = 0; i < in_dim; i++) {
    const float xi = input[i];
    if (xi == 0.0f) continue;
    const uint16_t* row = W + (size_t)i * out_dim;
    for (int j = 0; j < out_dim; j++) {
      out[j] += bf16_to_f32(row[j]) * xi;
    }
  }
  for (int j = 0; j < out_dim; j++) {
    if (out[j] < 0.0f) out[j] = 0.0f;
  }
}

/* In-place sigmoid. */
static inline void sigmoid_inplace(float* x, int n) {
  for (int i = 0; i < n; i++) {
    x[i] = 1.0f / (1.0f + expf(-x[i]));
  }
}

/* In-place softmax. */
static inline void softmax_inplace(float* x, int n) {
  float maxv = x[0];
  for (int i = 1; i < n; i++) if (x[i] > maxv) maxv = x[i];
  float sum = 0.0f;
  for (int i = 0; i < n; i++) {
    x[i] = expf(x[i] - maxv);
    sum += x[i];
  }
  const float inv = 1.0f / sum;
  for (int i = 0; i < n; i++) x[i] *= inv;
}

/*
 * Full dual-head forward pass. value_out and policy_out are written in
 * place. Caller-allocated scratch buffers (h1_buf, h2_buf) sized to h1 and h2.
 *
 * Returns 0 on success.
 */
EXPORT int mlp_forward(
    const float* W1, const float* b1,
    const float* W2, const float* b2,
    const float* Wv, const float* bv,
    const float* Wp, const float* bp,
    const float* input,
    float* h1_buf,
    float* h2_buf,
    float* value_out,
    float* policy_out,
    int in_dim,
    int h1,
    int h2,
    int value_dim,
    int policy_dim
) {
  /* trunk */
  linear_relu(input, W1, b1, h1_buf, in_dim, h1);
  linear_relu(h1_buf, W2, b2, h2_buf, h1, h2);

  /* value head */
  linear(h2_buf, Wv, bv, value_out, h2, value_dim);
  if (value_dim == 1) {
    sigmoid_inplace(value_out, 1);
  } else {
    softmax_inplace(value_out, value_dim);
  }

  /* policy head (caller passes Wp = NULL to skip) */
  if (Wp != NULL && policy_out != NULL && policy_dim > 0) {
    linear(h2_buf, Wp, bp, policy_out, h2, policy_dim);
    softmax_inplace(policy_out, policy_dim);
  }
  return 0;
}

/*
 * Value-only forward pass. Skips the policy branch. Returns the scalar
 * sigmoid output directly when value_dim==1; otherwise writes the full
 * softmax to value_out and returns the first slot.
 */
EXPORT float mlp_value_only(
    const float* W1, const float* b1,
    const float* W2, const float* b2,
    const float* Wv, const float* bv,
    const float* input,
    float* h1_buf,
    float* h2_buf,
    float* value_out,
    int in_dim,
    int h1,
    int h2,
    int value_dim
) {
  linear_relu(input, W1, b1, h1_buf, in_dim, h1);
  linear_relu(h1_buf, W2, b2, h2_buf, h1, h2);
  linear(h2_buf, Wv, bv, value_out, h2, value_dim);
  if (value_dim == 1) {
    sigmoid_inplace(value_out, 1);
  } else {
    softmax_inplace(value_out, value_dim);
  }
  return value_out[0];
}

/* bf16-trunk variant of mlp_forward: W1 and W2 are bf16, heads stay fp32. */
EXPORT int mlp_forward_bf16(
    const uint16_t* W1, const float* b1,
    const uint16_t* W2, const float* b2,
    const float* Wv, const float* bv,
    const float* Wp, const float* bp,
    const float* input,
    float* h1_buf,
    float* h2_buf,
    float* value_out,
    float* policy_out,
    int in_dim,
    int h1,
    int h2,
    int value_dim,
    int policy_dim
) {
  linear_relu_bf16(input, W1, b1, h1_buf, in_dim, h1);
  linear_relu_bf16(h1_buf, W2, b2, h2_buf, h1, h2);
  linear(h2_buf, Wv, bv, value_out, h2, value_dim);
  if (value_dim == 1) {
    sigmoid_inplace(value_out, 1);
  } else {
    softmax_inplace(value_out, value_dim);
  }
  if (Wp != NULL && policy_out != NULL && policy_dim > 0) {
    linear(h2_buf, Wp, bp, policy_out, h2, policy_dim);
    softmax_inplace(policy_out, policy_dim);
  }
  return 0;
}

/* bf16-trunk variant of mlp_value_only. */
EXPORT float mlp_value_only_bf16(
    const uint16_t* W1, const float* b1,
    const uint16_t* W2, const float* b2,
    const float* Wv, const float* bv,
    const float* input,
    float* h1_buf,
    float* h2_buf,
    float* value_out,
    int in_dim,
    int h1,
    int h2,
    int value_dim
) {
  linear_relu_bf16(input, W1, b1, h1_buf, in_dim, h1);
  linear_relu_bf16(h1_buf, W2, b2, h2_buf, h1, h2);
  linear(h2_buf, Wv, bv, value_out, h2, value_dim);
  if (value_dim == 1) {
    sigmoid_inplace(value_out, 1);
  } else {
    softmax_inplace(value_out, value_dim);
  }
  return value_out[0];
}
