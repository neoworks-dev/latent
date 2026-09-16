"""Runtime for the two dedicated mask models: BiRefNet-lite and SegFormer-ADE20K."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from common import MODEL_STORE, cuda_providers, read_json, resize_plane


def _session(path: Path, providers) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    return ort.InferenceSession(str(path), options, providers=providers or cuda_providers())


def _preprocess(image: np.ndarray, size: int, mean, std) -> np.ndarray:
    resized = Image.fromarray(image).resize((size, size), Image.BILINEAR)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - np.asarray(mean, np.float32)) / np.asarray(std, np.float32)
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


class BiRefNetLite:
    """Salient-object alpha matte -> the `subject` / `background` mask kinds."""

    def __init__(self, model_dir: Path | None = None, providers=None) -> None:
        self.dir = Path(model_dir or MODEL_STORE / "birefnet-lite")
        self.config = read_json(self.dir / "config.json")
        self.session = _session(self.dir / self.config["model_path"], providers)

    def alpha(self, image: np.ndarray) -> np.ndarray:
        """float32 alpha in [0,1] at the image's own resolution."""
        height, width = image.shape[:2]
        tensor = _preprocess(
            image, self.config["image_size"], self.config["image_mean"], self.config["image_std"]
        )
        # The upstream graph stops at the last decoder conv: these are logits.
        logits = self.session.run(
            [self.config["output_name"]], {self.config["input_name"]: tensor}
        )[0]
        probability = 1.0 / (1.0 + np.exp(-logits[0, 0]))
        return resize_plane(probability, width, height).clip(0.0, 1.0)


class SegformerAde:
    """150-class ADE20K semantic map -> the `sky` / `people` mask kinds."""

    def __init__(self, model_dir: Path | None = None, providers=None) -> None:
        self.dir = Path(model_dir or MODEL_STORE / "segformer-b2-ade20k")
        self.config = read_json(self.dir / "config.json")
        self.labels = read_json(self.dir / self.config["labels_path"])
        self.session = _session(self.dir / self.config["model_path"], providers)

    def logits(self, image: np.ndarray) -> np.ndarray:
        """[150,128,128] class logits at image_size/4."""
        tensor = _preprocess(
            image, self.config["image_size"], self.config["image_mean"], self.config["image_std"]
        )
        return self.session.run(["logits"], {"pixel_values": tensor})[0][0]

    def mask(self, image: np.ndarray, class_id: int, logits: np.ndarray | None = None) -> np.ndarray:
        """One class against the rest, upsampled before the comparison.

        Upsampling all 150 planes and taking argmax is what
        SegformerImageProcessor does, but for a single class the decision only
        needs the class plane and the best rival plane: two resizes instead of
        150. The rival is `max` taken before the resize, which is conservative
        at boundaries by well under a source pixel.
        """
        height, width = image.shape[:2]
        logits = self.logits(image) if logits is None else logits
        rival = np.max(np.delete(logits, class_id, axis=0), axis=0)
        return resize_plane(logits[class_id], width, height) > resize_plane(rival, width, height)

    def sky(self, image: np.ndarray, logits: np.ndarray | None = None) -> np.ndarray:
        return self.mask(image, self.config["class_sky"], logits)

    def people(self, image: np.ndarray, logits: np.ndarray | None = None) -> np.ndarray:
        return self.mask(image, self.config["class_person"], logits)
