"""Print input/output names, dtypes and shapes of an ONNX model via onnxruntime."""

import sys

import onnxruntime as ort


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: inspect_onnx.py <model.onnx>", file=sys.stderr)
        return 2
    session = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
    meta = session.get_modelmeta()
    print(f"model: {sys.argv[1]}")
    print(f"  producer={meta.producer_name!r} domain={meta.domain!r} version={meta.version}")
    for tensor in session.get_inputs():
        print(f"  IN  {tensor.name:<20} {tensor.type:<16} {tensor.shape}")
    for tensor in session.get_outputs():
        print(f"  OUT {tensor.name:<20} {tensor.type:<16} {tensor.shape}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
