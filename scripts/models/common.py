"""Shared helpers for the model store: paths, hashing, image loading, timing."""

from __future__ import annotations

import hashlib
import json
import os
import statistics
import time
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_STORE = Path(
    os.environ.get("LATENT_MODEL_STORE", Path.home() / ".local/share/latent/models")
)

# onnxruntime-gpu needs the system CUDA 13 / cuDNN 9 libraries that the engine also links.
CUDA_LIB_DIRS = ["/opt/cuda/lib64", "/usr/lib"]


def cuda_providers(device_id: int = 0) -> list:
    """CUDA EP first, CPU fallback. Same options the C++ engine should use."""
    return [
        (
            "CUDAExecutionProvider",
            {
                "device_id": device_id,
                "arena_extend_strategy": "kSameAsRequested",
                "cudnn_conv_algo_search": "EXHAUSTIVE",
                "do_copy_in_default_stream": True,
            },
        ),
        "CPUExecutionProvider",
    ]


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def load_image(path: str | Path, max_side: int = 2048) -> np.ndarray:
    """RGB uint8 HWC, longest side <= max_side. Raw files go through rawpy."""
    path = Path(path).expanduser()
    if path.suffix.lower() in {".arw", ".nef", ".cr2", ".cr3", ".dng", ".raf", ".rw2"}:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            rgb = raw.postprocess(
                use_camera_wb=True, output_bps=8, no_auto_bright=False, half_size=True
            )
        image = Image.fromarray(rgb)
    else:
        image = Image.open(path).convert("RGB")

    if max(image.size) > max_side:
        scale = max_side / max(image.size)
        size = (round(image.width * scale), round(image.height * scale))
        image = image.resize(size, Image.LANCZOS)
    return np.asarray(image.convert("RGB"), dtype=np.uint8)


def resize_plane(plane: np.ndarray, width: int, height: int) -> np.ndarray:
    """Bilinear resize of one float32 plane, align_corners=False.

    PIL's BILINEAR on an "F" image uses the same sampling grid as
    torch.nn.functional.interpolate(align_corners=False) — output centre
    (x + 0.5) * in/out - 0.5 in input coordinates — and agrees with it to 1.3e-5
    here. The C++ port must use that convention; align_corners=True shifts masks
    by half a source pixel at the edges.
    """
    return np.asarray(
        Image.fromarray(plane.astype(np.float32), mode="F").resize((width, height), Image.BILINEAR),
        dtype=np.float32,
    )


def gpu_memory_mb() -> float:
    """VRAM this process holds, per nvidia-smi. 0 if it cannot be read."""
    import os
    import subprocess

    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return 0.0
    for line in output.splitlines():
        pid, _, used = line.partition(",")
        if pid.strip() == str(os.getpid()):
            return float(used.strip())
    return 0.0


class Timer:
    """Collects wall-clock samples and reports p50/p90 in milliseconds."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.samples: list[float] = []

    def __enter__(self) -> "Timer":
        self._start = time.perf_counter()
        return self

    def __exit__(self, *_) -> None:
        self.samples.append((time.perf_counter() - self._start) * 1000.0)

    @property
    def p50(self) -> float:
        return statistics.median(self.samples) if self.samples else float("nan")

    @property
    def p90(self) -> float:
        if not self.samples:
            return float("nan")
        ordered = sorted(self.samples)
        return ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]

    def line(self) -> str:
        return (
            f"{self.label:<34} p50 {self.p50:8.1f} ms   p90 {self.p90:8.1f} ms"
            f"   n={len(self.samples)}"
        )
