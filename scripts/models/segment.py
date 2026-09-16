#!/usr/bin/env python3
"""Reference text -> mask pipeline: Florence-2 box -> SAM 2 mask.

    segment.py IMAGE --prompt "the person" --out /tmp/latent-ref-person
    segment.py IMAGE --box 220,440,1010,1740 --out /tmp/out       # pure SAM 2
    segment.py IMAGE --points 600,900:1 --points 300,300:0 --out /tmp/out
    segment.py IMAGE --kind sky --out /tmp/out                    # dedicated model

Writes <out>.png (8-bit mask) and <out>-overlay.png (red tint). With
--dump-tensors it also writes the stage-by-stage .npy tensors the C++ port
should diff against.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from common import Timer, load_image
from florence2 import Florence2
from sam2 import Sam2

OVERLAY_COLOR = np.array([255, 32, 32], dtype=np.float32)
OVERLAY_ALPHA = 0.45


def parse_box(text: str) -> tuple[float, float, float, float]:
    parts = [float(value) for value in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--box wants x0,y0,x1,y1")
    return tuple(parts)


def parse_point(text: str) -> tuple[float, float, float]:
    coords, _, label = text.partition(":")
    x, y = (float(value) for value in coords.split(","))
    return x, y, float(label or 1)


def write_overlay(image: np.ndarray, mask: np.ndarray, path: Path) -> None:
    base = image.astype(np.float32)
    tinted = base * (1.0 - OVERLAY_ALPHA) + OVERLAY_COLOR * OVERLAY_ALPHA
    blended = np.where(mask[..., None], tinted, base)
    Image.fromarray(blended.clip(0, 255).astype(np.uint8)).save(path)


def dump_tensors(directory: Path, stem: str, tensors: dict[str, np.ndarray]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, value in tensors.items():
        np.save(directory / f"{stem}-{name}.npy", value)


def run_kind(kind: str, image: np.ndarray, out: Path) -> int:
    """subject/background from BiRefNet, sky/people from SegFormer-ADE20K."""
    from dedicated import BiRefNetLite, SegformerAde

    timer = Timer(f"{kind} model")
    if kind in ("subject", "background"):
        with timer:
            alpha = BiRefNetLite().alpha(image)
        mask = alpha > 0.5 if kind == "subject" else alpha <= 0.5
    else:
        segformer = SegformerAde()
        with timer:
            logits = segformer.logits(image)
        mask = segformer.sky(image, logits) if kind == "sky" else segformer.people(image, logits)

    Image.fromarray((mask * 255).astype(np.uint8)).save(out.with_suffix(".png"))
    write_overlay(image, mask, Path(f"{out}-overlay.png"))
    print(f"kind={kind} coverage={float(mask.mean()):.4f}")
    print("  " + timer.line())
    print(f"wrote {out.with_suffix('.png')} and {out}-overlay.png")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image")
    parser.add_argument("--prompt", help="text for Florence-2 open-vocabulary detection")
    parser.add_argument("--box", type=parse_box, help="x0,y0,x1,y1 in image pixels; skips Florence-2")
    parser.add_argument("--points", type=parse_point, action="append", help="x,y[:label] (1 = keep, 0 = drop)")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--max-side", type=int, default=2048)
    parser.add_argument("--dump-tensors", type=Path, default=None)
    parser.add_argument("--florence-size", default="base")
    parser.add_argument(
        "--kind",
        choices=["subject", "background", "sky", "people"],
        help="dedicated model instead of Florence-2 + SAM 2",
    )
    arguments = parser.parse_args()

    if not arguments.prompt and not arguments.box and not arguments.points and not arguments.kind:
        parser.error("one of --prompt, --box, --points or --kind is required")

    image = load_image(arguments.image, arguments.max_side)
    height, width = image.shape[:2]
    stem = arguments.out.name
    timings = []

    if arguments.kind:
        return run_kind(arguments.kind, image, arguments.out)

    box = arguments.box
    detections = []
    if arguments.prompt and box is None:
        florence = Florence2(size=arguments.florence_size)
        timer = Timer("florence detect")
        with timer:
            detections = florence.detect(image, arguments.prompt)
        timings.append(timer)
        if not detections:
            print(f"florence-2 found nothing for {arguments.prompt!r}; writing an empty mask")
            empty = np.zeros((height, width), dtype=bool)
            Image.fromarray(empty.astype(np.uint8)).save(arguments.out.with_suffix(".png"))
            write_overlay(image, empty, Path(f"{arguments.out}-overlay.png"))
            return 0
        box = tuple(detections[0]["box"])
        print(f"florence-2: {detections}")

    sam = Sam2()
    encode_timer, decode_timer = Timer("sam2 encode"), Timer("sam2 decode")
    with encode_timer:
        embeddings = sam.encode(image)
    points = labels = None
    if arguments.points:
        points = np.array([[x, y] for x, y, _ in arguments.points], dtype=np.float32)
        labels = np.array([label for _, _, label in arguments.points], dtype=np.float32)
    with decode_timer:
        result = sam.segment(image, box=box, points=points, labels=labels, embeddings=embeddings)
    timings += [encode_timer, decode_timer]

    mask = result["mask"]
    coverage = float(mask.mean())
    Image.fromarray((mask * 255).astype(np.uint8)).save(arguments.out.with_suffix(".png"))
    write_overlay(image, mask, Path(f"{arguments.out}-overlay.png"))

    if arguments.dump_tensors:
        dump_tensors(
            arguments.dump_tensors,
            stem,
            {
                "image-uint8": image,
                "sam2-input": embeddings["_input"],
                "sam2-image-embed": embeddings["image_embed"],
                "sam2-high-res-feats-0": embeddings["high_res_feats_0"],
                "sam2-high-res-feats-1": embeddings["high_res_feats_1"],
                "sam2-low-res-logits": result["low_res_logits"],
                "sam2-iou": result["iou"],
                "mask-uint8": (mask * 255).astype(np.uint8),
            },
        )
        meta = {
            "image": str(arguments.image),
            "size": [width, height],
            "prompt": arguments.prompt,
            "box": list(box) if box else None,
            "detections": detections,
            "iou": result["iou"].tolist(),
            "best_index": result["best_index"],
            "coverage": coverage,
        }
        (arguments.dump_tensors / f"{stem}.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"box={box} iou={result['iou'][0][result['best_index']]:.3f} coverage={coverage:.4f}")
    for timer in timings:
        print("  " + timer.line())
    print(f"wrote {arguments.out.with_suffix('.png')} and {arguments.out}-overlay.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
