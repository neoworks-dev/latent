"""The MCP server Latent exposes to agents (PROMPT.md 3.4).

It runs inside latentd's embedded interpreter on a daemon thread, streamable HTTP on
127.0.0.1. Reads are structured (`get_stack`, `list_photos`), writes are scripts
(`run_python`) — there is deliberately no `add_op` tool, because the op-stack has one
write path.

THREADING: every tool body below calls into the C++ module, which hands the work to the
engine's server thread and releases the GIL while it waits (see engine/src/python/
module.cpp). Tool bodies must therefore never touch engine state directly.
"""

from __future__ import annotations

import json
import socket
import sys
import threading
from typing import Any

import latent
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.utilities.types import Image

server = MCPServer(
    "latent",
    instructions=(
        "Latent is a raw photo editor whose edits are an ordered op-stack. Read state with "
        "get_stack/list_photos, change it by running Python against the `latent` module with "
        "run_python (e.g. `latent.photo.develop.exposure += 0.5`), and look at the result with "
        "render_preview."
    ),
)


@server.tool()
def run_python(code: str, photo_id: int | None = None) -> dict[str, Any]:
    """Run Python against the live engine. The `latent` module is already imported.

    The last expression's repr comes back as `value`; stdout and stderr are captured.
    Examples: `latent.photo.develop.exposure = 0.7`, `latent.photo.stack.add("vibrance",
    value=20)`, `latent.undo()`, `latent.photo.stack_json()`.
    """
    # The tool name rides along so stack.changed reaches the UI as client "mcp:run_python".
    return latent._run_code(code, photo_id, tool="run_python")


@server.tool()
def get_stack(photo_id: int | None = None) -> dict[str, Any]:
    """The photo's op-stack, revision, undo state, histogram and clipping percentages."""
    return latent._stack_state(photo_id)


@server.tool()
def render_preview(
    photo_id: int | None = None,
    max_size: int = 1024,
    mask: list[str] | None = None,
) -> Image:
    """A JPEG of the photo's current state, long edge at most `max_size`.

    Pass `mask=["<op_id>"]` to get that op's combined mask instead, as a greyscale PNG
    (white = the op applies, black = it does not), or `mask=["<op_id>", "<component_id>"]`
    for one component's raster. That is how to check what a selection actually caught.
    """
    if mask:
        component_id = mask[1] if len(mask) > 1 else None
        raster = latent._preview_mask_png(photo_id, mask[0], component_id, max_size)
        return Image(data=raster, format="png")
    return Image(data=latent._preview_jpeg(photo_id, max_size), format="jpeg")


@server.tool()
def list_photos() -> list[dict[str, Any]]:
    """The catalog's photos, newest import first."""
    return latent._list_photos()


def _generative(op: str, tool: str, photo_id: int | None, arguments: dict[str, Any]) -> Any:
    """Runs `latent._generative` through the one write path and reads its JSON back.

    `repr` of a str, an int or None is a Python literal, which is what keeps a prompt with
    quotes in it from becoming code.
    """
    code = (
        "import latent._generative as generative\n"
        f"generative.emit({op!r}, **{arguments!r})\n"
    )
    answer = latent._run_code(code, photo_id, tool=tool)
    if not answer["ok"]:
        return {"error": answer["stderr"].strip() or "the script failed"}
    return json.loads(answer["stdout"] or "{}")


@server.tool()
def generative_fill(
    prompt: str,
    select: str | None = None,
    op_id: str | None = None,
    photo_id: int | None = None,
    seed: int = 0,
    model: str = "",
) -> Any:
    """Repaint a masked region from a prompt, through ComfyUI (PROMPT.md 3.5).

    `select` picks the region by text ("the cat"), which starts a selection job and
    returns its id — call again with the `op_id` from that answer once `get_stack` shows
    the component `ready`. The result is a cached raster: it never re-runs on its own, and
    `stale` in the stack means the pixels below it have changed since.
    """
    return _generative(
        "generative_fill",
        "generative_fill",
        photo_id,
        {"prompt": prompt, "select": select, "op_id": op_id, "seed": seed, "model": model},
    )


@server.tool()
def generative_remove(
    select: str | None = None,
    op_id: str | None = None,
    photo_id: int | None = None,
    seed: int = 0,
    model: str = "",
) -> Any:
    """Erase a masked region and fill it from its surroundings. Same flow as generative_fill,
    without a prompt: the graph is the inpaint-remove one."""
    return _generative(
        "remove",
        "generative_remove",
        photo_id,
        {"select": select, "op_id": op_id, "seed": seed, "model": model},
    )


@server.tool()
def generative_status() -> dict[str, Any]:
    """Which backend is selected, whether the `comfy` CLI is installed and its server is
    running, which graphs are shipped and which of them have their weights. Check this
    before a fill: a ComfyUI that is not running is the usual reason one fails."""
    return latent.generative.status()


@server.tool()
def export(
    output_dir: str,
    photo_ids: list[int] | None = None,
    format: str = "jpeg",  # noqa: A002 - the wire name; `export.run`'s params.format
    color_space: str = "srgb",
    quality: int | None = None,
    long_edge: int | None = None,
    dpi: int | None = None,
    sharpen: str | None = None,
    sharpen_amount: str = "standard",
    file_name_template: str | None = None,
) -> dict[str, Any]:
    """Write the current edit of one or more photos to disk, full resolution.

    `format` is jpeg | tiff16 | png | avif, `color_space` is srgb | displayP3 | adobeRGB |
    rec2020 | proPhoto, `sharpen` is screen | matte | glossy (omit for none). `long_edge`
    caps the long side in pixels; omit it for native size. `photo_ids` defaults to the
    current photo.

    Returns `{jobId, total, files}` at once — the files are written while the job runs, so
    the paths exist a moment later, not when this returns.
    """
    return latent.export(
        photo_ids,
        output_dir,
        format=format,
        color_space=color_space,
        quality=quality,
        long_edge=long_edge,
        dpi=dpi,
        sharpen=sharpen,
        sharpen_amount=sharpen_amount,
        file_name_template=file_name_template,
    )


@server.tool()
def merge_hdr(
    photo_ids: list[int],
    deghost: str = "none",
    auto_align: bool = True,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Merge 2 to 7 exposure-bracketed photos into one HDR photo and catalog it.

    Returns `{jobId}` at once: a full-resolution merge takes minutes. Watch job.progress
    with kind "merge"; its last notification carries `result.photoId`, which opens like any
    other photo and takes the whole Edit panel. No tone is applied — that is the user's.

    `deghost` is none / low / medium / high, for a scene where something moved between
    frames. Use `merge_preview` first if you want to see it before waiting for it.
    """
    return latent.merge.hdr(
        photo_ids, deghost=deghost, auto_align=auto_align, output_path=output_path
    )


@server.tool()
def merge_panorama(
    photo_ids: list[int],
    projection: str = "cylindrical",
    boundary_warp: int = 0,
    auto_crop: bool = True,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Stitch 2 to 12 overlapping photos, in shooting order, into one panorama.

    Returns `{jobId}`; `result.photoId` arrives on the job's last job.progress.
    `projection` is spherical / cylindrical / perspective. The stitch is translation-only,
    so a hand-held pan with roll or a close foreground will not close — it will report a
    pair that did not match rather than produce a broken picture.
    """
    return latent.merge.panorama(
        photo_ids,
        projection=projection,
        boundary_warp=boundary_warp,
        auto_crop=auto_crop,
        output_path=output_path,
    )


@server.tool()
def merge_preview(kind: str, photo_ids: list[int], long_edge: int = 1024) -> dict[str, Any]:
    """The same merge from the embedded JPEGs: seconds, a PNG, and no catalog row.

    `kind` is hdr / panorama / hdrPanorama. The job's last job.progress carries
    `result.previewPath`; read it with render_preview's sibling on disk, or just look at
    `result.width`/`height` to know whether the frames stitched at all.
    """
    return latent.merge.preview(kind, photo_ids, long_edge=long_edge)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _serve(port: int) -> None:
    try:
        server.run(transport="streamable-http", host="127.0.0.1", port=port)
    except Exception as error:  # noqa: BLE001 - the daemon must survive a dead MCP thread
        print(f"[warn] mcp server stopped: {error}", file=sys.stderr, flush=True)


def start(port: int = 0) -> int:
    """Start the server on a daemon thread and return the port it will listen on."""
    chosen = port or _free_port()
    threading.Thread(target=_serve, args=(chosen,), name="latent-mcp", daemon=True).start()
    return chosen
