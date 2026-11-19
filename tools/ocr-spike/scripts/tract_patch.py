"""Make a PaddleOCR DB detector loadable by tract (pure-Rust engine), with identical outputs.

tract-onnx 0.23.10 cannot analyse two ops of these detectors when the image size is symbolic:
- Resize (nearest, integer scale k) fails shape analysis;
- ConvTranspose computes its output shape only from concrete sizes.
Both have kernel = stride = k and no padding, so each is exactly a 1x1 Conv to C_out*k*k channels followed by
DepthToSpace(k, CRD). This script rewrites them so and checks the outputs against the original on ONNX Runtime.

Usage: uv run --no-project --with onnx --with onnxruntime python -I tract_patch.py in.onnx out.onnx
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, shape_inference

src, dst = sys.argv[1], sys.argv[2]
m = shape_inference.infer_shapes(onnx.load(src))
g = m.graph
init = {i.name: numpy_helper.to_array(i) for i in g.initializer}
chans = {v.name: v.type.tensor_type.shape.dim[1].dim_value for v in g.value_info}
attrs = lambda n: {a.name: helper.get_attribute_value(a) for a in n.attribute}


def conv_d2s(node, w, b, k):
    """1x1 Conv with weight w [Cout*k*k, Cin, 1, 1] and bias b, then DepthToSpace CRD."""
    mid = f"{node.name}.s2d"
    g.initializer.append(numpy_helper.from_array(w.astype(np.float32), f"{node.name}.w"))
    ins = [node.input[0], f"{node.name}.w"]
    if b is not None:
        g.initializer.append(numpy_helper.from_array(b.astype(np.float32), f"{node.name}.b"))
        ins.append(f"{node.name}.b")
    return [helper.make_node("Conv", ins, [mid], name=f"{node.name}.conv", kernel_shape=[1, 1]),
            helper.make_node("DepthToSpace", [mid], list(node.output), name=node.name, blocksize=k, mode="CRD")]


nodes, counts = [], {"Resize": 0, "ConvTranspose": 0}
for node in g.node:
    a = attrs(node)
    if node.op_type == "Resize" and len(node.input) > 2 and node.input[2] in init and a.get("mode") == b"nearest":
        s = init[node.input[2]]
        k = int(s[2])
        assert list(s) == [1, 1, k, k], (node.name, s)
        c = chans[node.input[0]]
        assert c > 0, node.name
        w = np.zeros((c * k * k, c, 1, 1))
        for ch in range(c):
            w[ch * k * k:(ch + 1) * k * k, ch] = 1  # every output sub-pixel copies its input channel
        nodes += conv_d2s(node, w, None, k)
        counts["Resize"] += 1
    elif node.op_type == "ConvTranspose":
        k = a["kernel_shape"][0]
        assert a["kernel_shape"] == [k, k] and a["strides"] == [k, k] and a.get("group", 1) == 1, node.name
        assert not any(a.get("pads", [0])) and not any(a.get("output_padding", [0])), node.name
        wt = init[node.input[1]]  # [Cin, Cout, k, k]
        cin, cout = wt.shape[:2]
        w = wt.transpose(1, 2, 3, 0).reshape(cout * k * k, cin, 1, 1)  # row co*k*k + i*k + j
        b = np.repeat(init[node.input[2]], k * k) if len(node.input) > 2 and node.input[2] else None
        nodes += conv_d2s(node, w, b, k)
        counts["ConvTranspose"] += 1
    else:
        nodes.append(node)
del g.node[:]
g.node.extend(nodes)
del g.value_info[:]
onnx.save(m, dst)

# Self-check on ONNX Runtime: same output as the original on a random page-sized input.
import onnxruntime as ort

x = np.random.default_rng(0).random((1, 3, 640, 480), np.float32)
o = ort.InferenceSession(src).run(None, {"x": x})[0]
p = ort.InferenceSession(dst).run(None, {"x": x})[0]
diff = float(np.abs(o - p).max())
print(f"{dst}: rewrote {counts}, max abs diff {diff:.2e}")
assert diff < 1e-4
