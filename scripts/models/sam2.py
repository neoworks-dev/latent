"""SAM 2 (hiera-base-plus) ONNX encoder + decoder.

Reference implementation for the C++ port. Every number here was read off the
exported graph or measured, not copied from a blog post.

Encoder graph starts at `patch_embed/proj/Conv` — there is no normalisation node
inside, so the caller owns resize + scale + ImageNet normalisation.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from common import MODEL_STORE, cuda_providers, read_json

# SAM 2 trains on ImageNet statistics; sam2/utils/transforms.py SAM2Transforms.
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Point label vocabulary of the exported decoder.
LABEL_BACKGROUND = 0.0
LABEL_FOREGROUND = 1.0
LABEL_BOX_TOP_LEFT = 2.0
LABEL_BOX_BOTTOM_RIGHT = 3.0
LABEL_PADDING = -1.0


def preprocess(image: np.ndarray, image_size: int = 1024) -> np.ndarray:
    """RGB uint8 HWC -> float32 NCHW [1,3,1024,1024].

    SAM 2 squashes to a square; it does *not* letterbox like SAM 1. Aspect ratio
    is restored when point coordinates and the output mask are rescaled.
    """
    resized = Image.fromarray(image).resize((image_size, image_size), Image.BILINEAR)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


def scale_points(points: np.ndarray, width: int, height: int, image_size: int = 1024) -> np.ndarray:
    """Original-image pixel coords -> encoder input coords."""
    scaled = points.astype(np.float32).copy()
    scaled[..., 0] *= image_size / float(width)
    scaled[..., 1] *= image_size / float(height)
    return scaled


def box_to_points(box: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    """A box is two points labelled 2 (top-left) and 3 (bottom-right)."""
    x0, y0, x1, y1 = box
    coords = np.array([[[x0, y0], [x1, y1]]], dtype=np.float32)
    labels = np.array([[LABEL_BOX_TOP_LEFT, LABEL_BOX_BOTTOM_RIGHT]], dtype=np.float32)
    return coords, labels


def upsample_mask(low_res_logits: np.ndarray, width: int, height: int) -> np.ndarray:
    """256x256 logits -> float32 mask logits at the original image size.

    Bilinear, align_corners=False, exactly what torch.nn.functional.interpolate
    does in sam2/utils/transforms.py postprocess_masks. PIL's BILINEAR resize on
    a float32 image matches that convention.
    """
    image = Image.fromarray(low_res_logits.astype(np.float32), mode="F")
    return np.asarray(image.resize((width, height), Image.BILINEAR), dtype=np.float32)


class Sam2:
    def __init__(self, model_dir: Path | None = None, providers=None) -> None:
        self.dir = Path(model_dir or MODEL_STORE / "sam2-hiera-base-plus")
        self.config = read_json(self.dir / "config.json")
        self.image_size = int(self.config.get("image_size", 1024))
        self.mask_size = int(self.config.get("mask_size", 256))

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.log_severity_level = 3
        providers = providers or cuda_providers()
        self.encoder = ort.InferenceSession(
            str(self.dir / self.config.get("encoder_path", "encoder.onnx")),
            options,
            providers=providers,
        )
        self.decoder = ort.InferenceSession(
            str(self.dir / self.config.get("decoder_path", "decoder.onnx")),
            options,
            providers=providers,
        )

    def encode(self, image: np.ndarray) -> dict[str, np.ndarray]:
        tensor = preprocess(image, self.image_size)
        names = [output.name for output in self.encoder.get_outputs()]
        values = self.encoder.run(names, {"image": tensor})
        embeddings = dict(zip(names, values))
        embeddings["_input"] = tensor
        return embeddings

    def decode(
        self,
        embeddings: dict[str, np.ndarray],
        point_coords: np.ndarray,
        point_labels: np.ndarray,
        width: int,
        height: int,
        mask_input: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Returns (low_res_logits [num_labels,3,256,256], iou [num_labels,3])."""
        labels_count = point_coords.shape[0]
        if mask_input is None:
            mask_input = np.zeros((labels_count, 1, self.mask_size, self.mask_size), np.float32)
            has_mask = np.zeros((labels_count,), np.float32)
        else:
            has_mask = np.ones((labels_count,), np.float32)

        feeds = {
            "image_embed": embeddings["image_embed"],
            "high_res_feats_0": embeddings["high_res_feats_0"],
            "high_res_feats_1": embeddings["high_res_feats_1"],
            "point_coords": scale_points(point_coords, width, height, self.image_size),
            "point_labels": point_labels.astype(np.float32),
            "mask_input": mask_input,
            "has_mask_input": has_mask,
        }
        masks, iou = self.decoder.run(["masks", "iou_predictions"], feeds)
        return masks, iou

    def segment_boxes(
        self,
        image: np.ndarray,
        boxes: list[tuple[float, float, float, float]],
        embeddings: dict[str, np.ndarray] | None = None,
    ) -> np.ndarray:
        """Union of one mask per box, one decoder call each.

        The decoder declares a leading `num_labels` dim but cannot actually run
        with num_labels > 1: `has_mask_input` is rank 1 and multiplies a
        [N,256,64,64] tensor, so ONNX broadcasting fails at node /Mul_14 for
        N > 1, and rank 4 is rejected outright. One call per prompt is the only
        working path with this export.
        """
        height, width = image.shape[:2]
        embeddings = embeddings if embeddings is not None else self.encode(image)
        union = np.zeros((height, width), dtype=bool)
        for box in boxes:
            union |= self.segment(image, box=tuple(box), embeddings=embeddings)["mask"]
        return union

    def segment(
        self,
        image: np.ndarray,
        box: tuple[float, float, float, float] | None = None,
        points: np.ndarray | None = None,
        labels: np.ndarray | None = None,
        embeddings: dict[str, np.ndarray] | None = None,
    ) -> dict:
        """One prompt -> best-IoU binary mask at image resolution."""
        height, width = image.shape[:2]
        embeddings = embeddings if embeddings is not None else self.encode(image)

        if box is not None:
            coords, point_labels = box_to_points(box)
            if points is not None:
                extra = np.asarray(points, np.float32)[None]
                coords = np.concatenate([coords, extra], axis=1)
                extra_labels = np.asarray(labels, np.float32)[None]
                point_labels = np.concatenate([point_labels, extra_labels], axis=1)
        else:
            coords = np.asarray(points, np.float32)[None]
            point_labels = np.asarray(labels, np.float32)[None]

        low_res, iou = self.decode(embeddings, coords, point_labels, width, height)
        best = int(np.argmax(iou[0]))
        logits = upsample_mask(low_res[0, best], width, height)
        return {
            "mask": logits > 0.0,
            "logits": logits,
            "low_res_logits": low_res,
            "iou": iou,
            "best_index": best,
            "embeddings": embeddings,
        }
