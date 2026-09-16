#!/usr/bin/env python3
"""Does Florence-2 -> SAM 2 cover subject / sky / background / people?

Runs the four Lightroom mask kinds over three CC0 photos and writes one contact
sheet per image to /tmp/latent-eval-<name>.png. Judgement is by eye; this only
produces the evidence.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

from common import load_image
from florence2 import Florence2
from sam2 import Sam2
from testdata import fetch_all

PEOPLE_LABELS = ("person", "people", "man", "woman", "human", "boy", "girl", "pedestrian")
OVERLAY_COLOR = np.array([255, 32, 32], np.float32)


def overlay(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    base = image.astype(np.float32)
    tinted = base * 0.55 + OVERLAY_COLOR * 0.45
    return np.where(mask[..., None], tinted, base).clip(0, 255).astype(np.uint8)


def contact_sheet(panels: list[tuple[str, np.ndarray]], path: Path) -> None:
    from PIL import ImageDraw

    width = 512
    scaled = []
    for title, panel in panels:
        image = Image.fromarray(panel)
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
        draw = ImageDraw.Draw(image)
        draw.rectangle([0, 0, width, 16], fill=(0, 0, 0))
        draw.text((4, 3), title, fill=(255, 255, 255))
        scaled.append(image)

    columns = 3
    rows = (len(scaled) + columns - 1) // columns
    cell_height = max(image.height for image in scaled)
    sheet = Image.new("RGB", (columns * width, rows * cell_height), (24, 24, 24))
    for index, image in enumerate(scaled):
        sheet.paste(image, ((index % columns) * width, (index // columns) * cell_height))
    sheet.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-side", type=int, default=1536)
    arguments = parser.parse_args()

    florence = Florence2()
    sam = Sam2()

    for name, path in fetch_all().items():
        image = load_image(path, arguments.max_side)
        height, width = image.shape[:2]
        embeddings = sam.encode(image)
        panels = [("source " + name, image)]
        report = []

        subject = florence.detect(image, "the main subject")
        subject_mask = np.zeros((height, width), bool)
        if subject:
            subject_mask = sam.segment(
                image, box=tuple(subject[0]["box"]), embeddings=embeddings
            )["mask"]
        panels.append((f"subject {subject[0]['label'] if subject else 'none'}", overlay(image, subject_mask)))
        panels.append(("background = NOT subject", overlay(image, ~subject_mask)))
        report.append(("subject", subject_mask.mean(), subject[0]["box"] if subject else None))

        sky = florence.detect(image, "sky")
        sky_mask = np.zeros((height, width), bool)
        if sky:
            sky_mask = sam.segment(image, box=tuple(sky[0]["box"]), embeddings=embeddings)["mask"]
        panels.append(("sky", overlay(image, sky_mask)))
        report.append(("sky", sky_mask.mean(), sky[0]["box"] if sky else None))

        detections = florence.run(image, "<OD>")["detections"]
        boxes = [
            item["box"]
            for item in detections
            if any(word in item["label"].lower() for word in PEOPLE_LABELS)
        ]
        people_mask = np.zeros((height, width), bool)
        if boxes:
            people_mask = sam.segment_boxes(image, boxes, embeddings=embeddings)
        panels.append((f"people <OD> x{len(boxes)}", overlay(image, people_mask)))
        report.append(("people", people_mask.mean(), len(boxes)))

        grounding = florence.run(image, "<CAPTION_TO_PHRASE_GROUNDING>", "people")["detections"]
        grounded_mask = np.zeros((height, width), bool)
        if grounding:
            grounded_mask = sam.segment_boxes(image, [d["box"] for d in grounding], embeddings=embeddings)
        panels.append((f"people grounding x{len(grounding)}", overlay(image, grounded_mask)))
        report.append(("people-grounding", grounded_mask.mean(), len(grounding)))

        out = Path(f"/tmp/latent-eval-{name}.png")
        contact_sheet(panels, out)
        print(f"{name}: {out}")
        for kind, coverage, extra in report:
            print(f"   {kind:<18} coverage {coverage:6.3f}   {extra}")
        print(f"   <OD> labels: {[d['label'] for d in detections]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
