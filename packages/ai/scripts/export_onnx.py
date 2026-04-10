"""
Convert a v3 DualHeadMlpJson (model.json) to ONNX format.

Usage:
    pip install numpy onnx
    python3 packages/ai/scripts/export_onnx.py \
        --in packages/ai/data/model.json \
        --out packages/ai/data/model.onnx

The exported model takes a float32 input of shape [1, feature_dim]
and produces two outputs:
    value:  [1, 4]   — softmax probabilities per power
    policy: [1, 298] — softmax probabilities per action slot
"""

import argparse
import json
import numpy as np

try:
    import onnx
    from onnx import helper, TensorProto, numpy_helper
except ImportError:
    print("pip install onnx")
    raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    args = ap.parse_args()

    with open(args.in_path) as f:
        model = json.load(f)

    # v3 format: { version: 3, layers: [...], policyHead: {...} }
    version = model.get("version", 2)
    if version < 3:
        print(f"Model version {version} doesn't have a policy head — only v3+ supported.")
        raise SystemExit(1)

    layers = model["layers"]
    policy_head = model["policyHead"]

    nodes = []
    initializers = []
    input_name = "input"

    prev_output = input_name
    # W is stored as [inDim, outDim] in model.json
    in_dim = len(layers[0]["W"]) if layers else 0

    # Build trunk layers
    for i, layer in enumerate(layers):
        # W is [inDim, outDim] — Gemm with transB=0 expects [inDim, outDim]
        W = np.array(layer["W"], dtype=np.float32)
        b = np.array(layer["b"], dtype=np.float32)

        w_name = f"trunk_W{i}"
        b_name = f"trunk_b{i}"
        out_name = f"trunk_linear{i}"

        initializers.append(numpy_helper.from_array(W, name=w_name))
        initializers.append(numpy_helper.from_array(b, name=b_name))

        # Gemm: Y = X * W + b (transB=0 since we already transposed)
        nodes.append(helper.make_node("Gemm", [prev_output, w_name, b_name], [out_name],
                                       alpha=1.0, beta=1.0, transA=0, transB=0))

        act = layer.get("activation", "relu")
        if act == "relu":
            relu_out = f"trunk_relu{i}"
            nodes.append(helper.make_node("Relu", [out_name], [relu_out]))
            prev_output = relu_out
        elif act == "softmax":
            sm_out = f"trunk_softmax{i}"
            nodes.append(helper.make_node("Softmax", [out_name], [sm_out], axis=1))
            prev_output = sm_out
        else:
            prev_output = out_name

    trunk_output = prev_output

    # Check if the last trunk layer is already the value head (has softmax activation)
    last_act = layers[-1].get("activation", "relu") if layers else "relu"
    if last_act == "softmax":
        # The last trunk layer IS the value head (softmax output)
        value_output = trunk_output
        # Trunk for policy branches off from the second-to-last relu
        # Re-read: in the TS code, policy branches from the last HIDDEN layer output.
        # The trunk layers are: [hidden1, hidden2, value_head].
        # Policy head takes input from hidden2's relu output.
        # So we need the output just before the last layer.
        # That's trunk_relu{len(layers)-2} (the second-to-last layer's relu output)
        policy_input = f"trunk_relu{len(layers) - 2}"
    else:
        # All trunk layers are hidden; value head is separate
        value_output = trunk_output
        policy_input = trunk_output

    # Policy head
    pW = np.array(policy_head["W"], dtype=np.float32)
    pb = np.array(policy_head["b"], dtype=np.float32)
    initializers.append(numpy_helper.from_array(pW, name="policy_W"))
    initializers.append(numpy_helper.from_array(pb, name="policy_b"))

    nodes.append(helper.make_node("Gemm", [policy_input, "policy_W", "policy_b"],
                                   ["policy_linear"], alpha=1.0, beta=1.0, transA=0, transB=0))
    nodes.append(helper.make_node("Softmax", ["policy_linear"], ["policy"], axis=1))

    # Input/output specs
    X = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, in_dim])
    value_out = helper.make_tensor_value_info(value_output, TensorProto.FLOAT, [1, len(layers[-1]["b"])])
    policy_out = helper.make_tensor_value_info("policy", TensorProto.FLOAT, [1, len(policy_head["b"])])

    graph = helper.make_graph(nodes, "ruin_mlp", [X], [value_out, policy_out],
                               initializer=initializers)
    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    onnx_model.ir_version = 8
    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, args.out_path)
    print(f"Exported ONNX model to {args.out_path}")
    print(f"  Input:  {in_dim}")
    print(f"  Value:  {len(layers[-1]['b'])}")
    print(f"  Policy: {len(policy_head['b'])}")


if __name__ == "__main__":
    main()
