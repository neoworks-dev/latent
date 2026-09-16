#!/usr/bin/env python3
"""Put every AI mask model in the store, idempotently, and verify it runs.

    fetch.py                 # check / download / export what is missing
    fetch.py --force NAME    # redo one model even if it is already there
    fetch.py --verify        # one inference per model on CUDA, with timings

The store is ~/.local/share/latent/models (override with LATENT_MODEL_STORE).
Every file lands in manifest.json with its sha256 and size, so the engine can
refuse to load a model it does not recognise.
"""

from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

import numpy as np

from common import (
    MODEL_STORE,
    Timer,
    gpu_memory_mb,
    load_image,
    read_json,
    sha256_file,
    write_json,
)

MANIFEST = MODEL_STORE / "manifest.json"
SAMPLE_RAW = Path("~/Downloads/DSC00120.ARW").expanduser()


def sam2_present(directory: Path) -> bool:
    return (directory / "encoder.onnx").exists() and (directory / "decoder.onnx").exists()


def install_sam2(directory: Path) -> None:
    """SAM 2 is not exportable from here and is not on the Hub as ONNX.

    facebook/sam2-hiera-base-plus ships a .pt checkpoint; the two graphs in the
    store came from samexporter against that checkpoint on another machine. If
    they are missing, re-run samexporter — this script will not invent them.
    """
    raise SystemExit(
        f"{directory} is missing encoder.onnx/decoder.onnx.\n"
        "Re-export with samexporter against facebook/sam2-hiera-base-plus:\n"
        "  python -m samexporter.export_sam2 --model_type sam2_hiera_base_plus \\\n"
        "      --checkpoint sam2_hiera_base_plus.pt --output <store>/sam2-hiera-base-plus"
    )


MODELS = {
    "sam2-hiera-base-plus": {
        "role": "objects / text -> mask, prompted by box or points",
        "present": sam2_present,
        "install": install_sam2,
    },
    "florence-2-base": {
        "role": "text -> box (open-vocabulary detection, phrase grounding)",
        "present": lambda directory: (directory / "onnx/decoder_model.onnx").exists(),
        "install": lambda directory: __import__("export_florence2").export("base", directory),
    },
    "birefnet-lite": {
        "role": "subject / background alpha matte",
        "present": lambda directory: (directory / "model.onnx").exists(),
        "install": lambda directory: __import__("export_dedicated").export_birefnet(directory),
    },
    "segformer-b2-ade20k": {
        "role": "sky / people semantic classes",
        "present": lambda directory: (directory / "model.onnx").exists(),
        "install": lambda directory: __import__("export_dedicated").export_segformer(directory),
    },
}


def manifest_entry(directory: Path) -> dict:
    files = {}
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        files[str(path.relative_to(directory))] = {
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    return {
        "config": read_json(directory / "config.json"),
        "bytes": sum(item["bytes"] for item in files.values()),
        "files": files,
    }


def ensure(name: str, force: bool) -> None:
    spec = MODELS[name]
    directory = MODEL_STORE / name
    if spec["present"](directory) and not force:
        print(f"{name}: present")
        return
    print(f"{name}: installing into {directory}")
    spec["install"](directory)


def write_manifest() -> dict:
    manifest = {
        "store": str(MODEL_STORE),
        "generated": datetime.datetime.now(datetime.UTC).isoformat(),
        "models": {},
    }
    for name, spec in MODELS.items():
        directory = MODEL_STORE / name
        if not directory.exists():
            continue
        entry = manifest_entry(directory)
        entry["role"] = spec["role"]
        manifest["models"][name] = entry
    write_json(MANIFEST, manifest)
    return manifest


def sample_image(max_side: int = 1536) -> np.ndarray:
    if SAMPLE_RAW.exists():
        return load_image(SAMPLE_RAW, max_side)
    from testdata import fetch

    return load_image(fetch("pet"), max_side)


def verify(runs: int = 10) -> int:
    """One model at a time: the four together do not fit next to a desktop.

    BiRefNet's deform-conv decomposition alone asks for an 822 MB transient, and
    holding all four sessions plus that transient exhausted 16 GB during
    development. The engine must load a mask model, run the job, and drop the
    session; only SAM 2 is worth keeping warm because its encoder is reused for
    every prompt on the same photo.
    """
    image = sample_image()
    height, width = image.shape[:2]
    source = SAMPLE_RAW if SAMPLE_RAW.exists() else "testdata/pet.jpg"
    print(f"verify on {width}x{height} from {source}")
    box = (width * 0.25, height * 0.2, width * 0.8, height * 0.95)

    def report(label: str, load: Timer, stages: list[Timer], note: str = "") -> None:
        print(f"{label}   load {load.p50:.0f} ms   VRAM {gpu_memory_mb():.0f} MB")
        for timer in stages:
            print("  " + timer.line())
        if note:
            print(f"  {note}")

    from sam2 import Sam2

    load = Timer("load")
    with load:
        sam = Sam2()
    encode, decode = Timer("sam2 encoder (1024x1024)"), Timer("sam2 decoder (1 box prompt)")
    sam.segment(image, box=box)
    for _ in range(runs):
        with encode:
            embeddings = sam.encode(image)
        with decode:
            result = sam.segment(image, box=box, embeddings=embeddings)
    report("sam2-hiera-base-plus", load, [encode, decode], f"iou {result['iou'][0].max():.3f}")
    del sam

    from florence2 import Florence2

    load = Timer("load")
    with load:
        florence = Florence2()
    vision, text = Timer("florence-2 vision (768x768)"), Timer("florence-2 encode+greedy decode")
    florence.run(image, "<OPEN_VOCABULARY_DETECTION>", "the person")
    for _ in range(runs):
        with vision:
            features = florence.encode_image(image)
        embeds, mask = florence.build_inputs("Locate the person in the image.", features)
        with text:
            tokens = florence.generate(embeds, mask)
    detection = florence.run(image, "<OPEN_VOCABULARY_DETECTION>", "the person")
    report(
        "florence-2-base",
        load,
        [vision, text],
        f"{len(tokens)} tokens, {detection['raw']} -> {detection['detections']}",
    )
    del florence

    from dedicated import BiRefNetLite

    load = Timer("load")
    with load:
        birefnet = BiRefNetLite()
    matte = Timer("birefnet-lite (1024x1024)")
    birefnet.alpha(image)
    for _ in range(runs):
        with matte:
            alpha = birefnet.alpha(image)
    report("birefnet-lite", load, [matte], f"subject coverage {float((alpha > 0.5).mean()):.4f}")
    del birefnet

    from dedicated import SegformerAde

    load = Timer("load")
    with load:
        segformer = SegformerAde()
    semantic = Timer("segformer-b2-ade20k (512x512)")
    segformer.logits(image)
    for _ in range(runs):
        with semantic:
            logits = segformer.logits(image)
    report(
        "segformer-b2-ade20k",
        load,
        [semantic],
        f"sky {float(segformer.sky(image, logits).mean()):.4f}"
        f"  people {float(segformer.people(image, logits).mean()):.4f}",
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="append", choices=sorted(MODELS), default=[])
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--runs", type=int, default=10)
    arguments = parser.parse_args()

    MODEL_STORE.mkdir(parents=True, exist_ok=True)
    for name in MODELS:
        ensure(name, name in arguments.force)

    manifest = write_manifest()
    total = sum(entry["bytes"] for entry in manifest["models"].values())
    print(f"\nmanifest: {MANIFEST}")
    for name, entry in manifest["models"].items():
        print(f"  {name:<22} {entry['bytes'] / 1e6:8.1f} MB  {len(entry['files']):2d} files  {entry['role']}")
    print(f"  {'total':<22} {total / 1e6:8.1f} MB")

    if arguments.verify:
        print()
        return verify(arguments.runs)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    raise SystemExit(main())
