"""Export the denoise model the `denoise` op runs on (ISSUES.md 51).

  scunet-color-real  SCUNet, 17.9 M params, Apache-2.0 (cszn/SCUNet). Trained on
                     the practical degradation model rather than on additive
                     Gaussian noise, which is what makes it useful on a real
                     high-ISO frame instead of on a synthetic benchmark.

Why this and not a diffusion model: the first build of AI Denoise ran SDXL
img2img at denoise 0.3, and a generator asked to re-roll a noisy frame does not
remove noise — it redraws the picture slightly softer, which is exactly what it
looked like. A restoration network is trained on (noisy, clean) pairs and has an
identity to fall back on.

The checkpoint is a .pth of bare tensors, so the architecture has to come from
somewhere: `spandrel` carries a clean-room copy of every restoration arch and
picks the right one from the state dict, which is the same route ComfyUI takes.
It is an export-time dependency only — the engine loads the ONNX.

The graph is exported at a fixed 512x512 because SCUNet's swin blocks window the
attention: a dynamic height and width export traces reshapes that only hold for
the size it was traced at, and ORT then either refuses the shape or returns a
seam. The engine tiles, which it would have to do at 24 MP regardless
(engine/src/ai/denoise.cpp).
"""

from __future__ import annotations

import datetime
import urllib.request
from pathlib import Path

import torch

from common import MODEL_STORE, write_json

CHECKPOINT_URL = "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth"
TILE = 512


def export_scunet(out_dir: Path) -> None:
    from spandrel import ModelLoader

    out_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = out_dir / "scunet_color_real_psnr.pth"
    if not checkpoint.exists():
        print(f"downloading {CHECKPOINT_URL}")
        urllib.request.urlretrieve(CHECKPOINT_URL, checkpoint)

    descriptor = ModelLoader().load_from_file(str(checkpoint))
    if descriptor.scale != 1 or descriptor.input_channels != 3:
        raise SystemExit(f"not a 3-channel restoration model: {descriptor.architecture}")
    model = descriptor.model.eval()

    onnx_path = out_dir / "model.onnx"
    example = torch.rand(1, 3, TILE, TILE)
    with torch.no_grad():
        torch.onnx.export(
            model,
            example,
            str(onnx_path),
            input_names=["image"],
            output_names=["denoised"],
            opset_version=17,
            dynamo=False,
        )
    # The .pth is the source, not something the engine reads; keeping it would put
    # 72 MB of duplicate weights in the store and in every manifest hash.
    checkpoint.unlink()

    write_json(
        out_dir / "config.json",
        {
            "model": "scunet-color-real",
            "architecture": "SCUNet",
            "source": CHECKPOINT_URL,
            "license": "Apache-2.0",
            "role": "whole-frame denoise for the `denoise` op",
            "input": {
                "name": "image",
                "layout": "NCHW",
                "shape": [1, 3, TILE, TILE],
                "range": "0..1, linear-free sRGB-encoded RGB",
            },
            "output": {"name": "denoised", "layout": "NCHW", "shape": [1, 3, TILE, TILE]},
            "tile": TILE,
            "exported": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB)")


def main() -> int:
    export_scunet(MODEL_STORE / "scunet-color-real")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
