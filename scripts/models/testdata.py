"""Three CC0 test photos, cached next to the scripts. Used by evaluate.py."""

from __future__ import annotations

from pathlib import Path

import requests

CACHE = Path(__file__).parent / "testdata"

# Openverse, license=cc0, picked by hand for the four mask kinds.
IMAGES = {
    "street": (
        "https://images.rawpixel.com/editor_1024/cHJpdmF0ZS9sci9pbWFnZXMvd2Vic2l0ZS8yMDIyLTA0"
        "L3Vwd2s0ODMwNTE5MC13aWtpbWVkaWEtaW1hZ2Uta293cnY1cDkuanBn.jpg",
        "Crowded people walking street, Santiago (CC0, via Openverse/rawpixel)",
    ),
    "landscape": (
        "https://live.staticflickr.com/65535/52331019325_c86ab76e2e_b.jpg",
        "Farming on the Headland (CC0, via Openverse/Flickr)",
    ),
    "pet": (
        "https://live.staticflickr.com/8574/16120825474_ed11203dbb_b.jpg",
        "lisa-the-dog (CC0, via Openverse/Flickr)",
    ),
}


def fetch(name: str) -> Path:
    url, _ = IMAGES[name]
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}.jpg"
    if path.exists():
        return path
    response = requests.get(url, timeout=120, headers={"User-Agent": "latent-model-eval/0.1"})
    response.raise_for_status()
    path.write_bytes(response.content)
    return path


def fetch_all() -> dict[str, Path]:
    return {name: fetch(name) for name in IMAGES}
