"""Photo Merge: ``latent.merge.hdr(...)``, ``.panorama(...)``, ``.hdr_panorama(...)``,
``.star_trail(...)``.

Thin keyword wrappers over the engine's ``_start_merge``. Each one queues a job and returns
``{"jobId": ...}`` at once — the merged photo's id arrives on that job's last
``job.progress``, in ``result.photoId``, because a full-resolution merge takes minutes and
nothing in the engine blocks the server thread for that long.

The options mirror Lightroom's Photo Merge dialog (``reference/lightroom/hdr-panorama.md``)
and so do the defaults: Auto Align on, Deghost off, Auto Crop on, Boundary Warp 0.

    latent.merge.hdr([12, 13, 14], deghost="medium")
    latent.merge.panorama([20, 21, 22], projection="cylindrical", boundary_warp=40)
    latent.merge.star_trail(night_sequence, gap_fill=2, foreground="firstFrame")
    latent.merge.preview("hdr", [12, 13, 14])     # a PNG to look at first
"""

from __future__ import annotations

from typing import Any, Iterable

import latent

__all__ = ["hdr", "panorama", "hdr_panorama", "star_trail", "preview"]

_KINDS = ("hdr", "panorama", "hdrPanorama", "starTrail")


def _photo_ids(photos: Iterable[Any]) -> list[int]:
    """Accepts ids, Photo objects, or a mix — the same leniency the rest of the API has."""
    ids: list[int] = []
    for photo in photos:
        ids.append(int(getattr(photo, "id", photo)))
    if len(ids) < 2:
        raise ValueError("a merge needs at least two photos")
    return ids


def _request(kind: str, photos: Iterable[Any], **options: Any) -> dict[str, Any]:
    if kind not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}, not {kind!r}")
    request: dict[str, Any] = {"kind": kind, "photoIds": _photo_ids(photos)}
    for name, value in options.items():
        if value is not None:
            request[name] = value
    return request


def hdr(
    photos: Iterable[Any],
    deghost: str = "none",
    auto_align: bool = True,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Merge 2 to 7 exposures into one linear 16-bit TIFF and catalog it.

    `deghost` is Lightroom's Deghost Amount: none / low / medium / high.
    """
    return latent._start_merge(
        _request(
            "hdr",
            photos,
            deghost=deghost,
            autoAlign=auto_align,
            outputPath=output_path,
        )
    )


def panorama(
    photos: Iterable[Any],
    projection: str = "cylindrical",
    boundary_warp: int = 0,
    auto_crop: bool = True,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Stitch 2 to 12 overlapping frames, in shooting order, into one linear 16-bit TIFF.

    `projection` is spherical / cylindrical / perspective; the first two need a 35 mm
    equivalent focal length in the files and fall back to perspective without one.
    """
    return latent._start_merge(
        _request(
            "panorama",
            photos,
            projection=projection,
            boundaryWarp=boundary_warp,
            autoCrop=auto_crop,
            outputPath=output_path,
        )
    )


def hdr_panorama(
    photos: Iterable[Any],
    deghost: str = "none",
    auto_align: bool = True,
    projection: str = "cylindrical",
    boundary_warp: int = 0,
    auto_crop: bool = True,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Every frame of every bracket, in shooting order.

    The bracket sets are found from the exposure pattern: same size, same EV offsets. A set
    of frames with no repeating pattern is an error — merge them as a panorama instead.
    """
    return latent._start_merge(
        _request(
            "hdrPanorama",
            photos,
            deghost=deghost,
            autoAlign=auto_align,
            projection=projection,
            boundaryWarp=boundary_warp,
            autoCrop=auto_crop,
            outputPath=output_path,
        )
    )


def star_trail(
    photos: Iterable[Any],
    blend: str = "lighten",
    gap_fill: int = 0,
    foreground: str = "lighten",
    foreground_threshold: float = 2,
    decay: float = 0,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Stack 2 to 500 frames of a night sequence, in shooting order, into one 16-bit TIFF.

    `blend` is lighten (the brightest frame per pixel — the trails) or average (their mean,
    which is one long exposure and no trails). `gap_fill` inserts that many sub-frames
    between each pair to bridge the camera's write time; `foreground="firstFrame"` keeps the
    ground from frame one so the stack does not collect every frame's hot pixels; `decay`
    fades the older end of each trail into a comet tail.

    The frames are decoded into the stack one at a time, so the sequence never has to fit in
    memory — but they are decoded, so 300 raws is 300 decodes.
    """
    return latent._start_merge(
        _request(
            "starTrail",
            photos,
            blend=blend,
            gapFill=gap_fill,
            foreground=foreground,
            foregroundThreshold=foreground_threshold,
            decay=decay,
            outputPath=output_path,
        )
    )


def preview(kind: str, photos: Iterable[Any], long_edge: int = 1024, **options: Any) -> dict[str, Any]:
    """The same merge from the raws' embedded JPEGs: seconds, and no catalog row.

    The job's last `job.progress` carries `result.previewPath` and `result.previewUrl`.
    """
    request = _request(kind, photos, longEdge=long_edge, **options)
    request["preview"] = True
    return latent._start_merge(request)
