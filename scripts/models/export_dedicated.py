"""Export the two dedicated mask models to ONNX.

Florence-2 -> SAM 2 is a text-prompt tool. It is not a `subject`/`sky`/`people`
detector: Florence never abstains, so `sky` on a studio backdrop returns the
backdrop, and its `<OD>` output saturates at ~30 boxes so a crowd comes back as
three people and twenty-four shoes. These two models cover those kinds directly.

  birefnet-lite        MIT, 44 M params. Salient-object alpha matte -> subject,
                       background = 1 - alpha. Matches Lightroom "Select Subject".
  segformer-b2-ade20k  NVIDIA source-code licence, 27 M params. 150-class ADE20K
                       semantic map; class 2 = sky, class 12 = person.
"""

from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

import torch
from torch import nn

from common import MODEL_STORE, write_json

BIREFNET_REPO = "ZhengPeng7/BiRefNet_lite"
BIREFNET_ONNX_REPO = "onnx-community/BiRefNet_lite"
SEGFORMER_REPO = "nvidia/segformer-b2-finetuned-ade-512-512"
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


class SegformerLogits(nn.Module):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        return self.model(pixel_values=pixel_values).logits


def export_birefnet(out_dir: Path, image_size: int = 1024) -> None:
    """Copy the upstream ONNX in; BiRefNet cannot be exported from torch here.

    Its decoder uses torchvision deformable convolution and torch.onnx.export
    stops with "unrecognized namespace torchvision::deform_conv2d" — ONNX has no
    such operator. onnx-community shipped a decomposed export of the same MIT
    weights, so it is fetched instead of re-derived.

    The fp16 variant is what lands in the store: identical masks (subject
    coverage agrees to four decimals on the sample raw), 114 MB instead of 224,
    174 ms instead of 230, 6.2 GB peak VRAM instead of 7.5. Its inputs and
    outputs are still float32 — the casts are inside the graph.
    """
    import shutil

    from huggingface_hub import hf_hub_download

    out_dir.mkdir(parents=True, exist_ok=True)
    print("  fetching birefnet-lite/model.onnx (fp16 weights) ...", flush=True)
    source = hf_hub_download(BIREFNET_ONNX_REPO, "onnx/model_fp16.onnx")
    shutil.copyfile(source, out_dir / "model.onnx")
    write_json(
        out_dir / "config.json",
        {
            "model_name": "birefnet-lite",
            "checkpoint_id": BIREFNET_REPO,
            "onnx_source": f"{BIREFNET_ONNX_REPO}/onnx/model_fp16.onnx",
            "kind": "salient-object-logits",
            "license": "MIT",
            "model_path": "model.onnx",
            "input_name": "input_image",
            "output_name": "output_image",
            "image_size": image_size,
            "image_mean": IMAGENET_MEAN,
            "image_std": IMAGENET_STD,
            "output": "raw float32 logits [1,1,1024,1024]; apply sigmoid, then bilinear-resize",
            "weights_dtype": "float16",
            "mask_kinds": ["subject", "background"],
            "conversion_date": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )


def export_segformer(out_dir: Path, image_size: int = 512) -> None:
    from transformers import SegformerForSemanticSegmentation

    model = SegformerForSemanticSegmentation.from_pretrained(SEGFORMER_REPO).eval()
    out_dir.mkdir(parents=True, exist_ok=True)
    print("  exporting segformer-b2-ade20k/model.onnx ...", flush=True)
    with torch.no_grad():
        torch.onnx.export(
            SegformerLogits(model),
            (torch.zeros(1, 3, image_size, image_size),),
            str(out_dir / "model.onnx"),
            input_names=["pixel_values"],
            output_names=["logits"],
            dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )
    (out_dir / "labels.json").write_text(
        json.dumps({int(k): v for k, v in model.config.id2label.items()}, indent=2) + "\n"
    )
    write_json(
        out_dir / "config.json",
        {
            "model_name": "segformer-b2-ade20k",
            "checkpoint_id": SEGFORMER_REPO,
            "kind": "semantic-segmentation",
            "license": "NVIDIA Source Code License-NC",
            "model_path": "model.onnx",
            "labels_path": "labels.json",
            "image_size": image_size,
            "image_mean": IMAGENET_MEAN,
            "image_std": IMAGENET_STD,
            "output": "logits [1,150,128,128] (image_size/4); argmax then bilinear-resize",
            "class_sky": 2,
            "class_person": 12,
            "mask_kinds": ["sky", "people"],
            "conversion_date": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=["birefnet", "segformer"], default=None)
    arguments = parser.parse_args()
    if arguments.only in (None, "birefnet"):
        export_birefnet(MODEL_STORE / "birefnet-lite")
    if arguments.only in (None, "segformer"):
        export_segformer(MODEL_STORE / "segformer-b2-ade20k")
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
