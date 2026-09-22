"""Runtime for the relighting depth model: Depth Anything V2 Small.

The graph answers *relative inverse* depth — big where something is near, small
where it is far, with no unit and no zero point. That is all a relight needs: the
light is placed at a depth the user picks on the same 0..1 scale, and the shading
only ever compares two of them. Nothing here reconstructs metric distance.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from common import MODEL_STORE, cuda_providers, read_json, resize_plane


class DepthAnythingV2:
    """RGB -> nearness in [0,1] at the image's own resolution, 1 = nearest."""

    def __init__(self, model_dir: Path | None = None, providers=None) -> None:
        self.dir = Path(model_dir or MODEL_STORE / "depth-anything-v2-small")
        self.config = read_json(self.dir / "config.json")
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.log_severity_level = 3
        self.session = ort.InferenceSession(
            str(self.dir / self.config["model_path"]), options, providers=providers or cuda_providers()
        )

    def _preprocess(self, image: np.ndarray) -> np.ndarray:
        size = self.config["image_size"]
        resized = Image.fromarray(image).resize((size, size), Image.BILINEAR)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.asarray(self.config["image_mean"], np.float32)) / np.asarray(
            self.config["image_std"], np.float32
        )
        return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)

    def raw(self, image: np.ndarray) -> np.ndarray:
        """[518,518] inverse depth, straight out of the graph."""
        tensor = self._preprocess(image)
        return self.session.run(
            [self.config["output_name"]], {self.config["input_name"]: tensor}
        )[0][0]

    def depth(self, image: np.ndarray) -> np.ndarray:
        """Nearness in [0,1] at the image's size: 1 is the closest thing in frame.

        Normalised per image against its own 1st/99th percentile rather than its
        min and max, because one blown pixel of sky or one lens flare otherwise
        takes the whole range and flattens everything else into a few levels.
        The normalisation happens on the graph's own 518x518 plane, before the
        resize, so the engine can do the same without sorting a megapixel twice.
        """
        height, width = image.shape[:2]
        inverse_depth = self.raw(image)
        low, high = np.percentile(inverse_depth, [1.0, 99.0])
        if high - low < 1e-6:
            return np.zeros((height, width), dtype=np.float32)
        nearness = np.clip((inverse_depth - low) / (high - low), 0.0, 1.0)
        return resize_plane(nearness, width, height).clip(0.0, 1.0)
