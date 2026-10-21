"""The MCP server Latent exposes to agents (PROMPT.md 3.4).

It runs inside latentd's embedded interpreter on a daemon thread, streamable HTTP on
127.0.0.1. Reads are structured (`get_stack`, `list_photos`), writes are scripts
(`run_python`) — there is deliberately no `add_op` tool, because the op-stack has one
write path.

HARNESS CONTRACT (neoworks-dev/harness#34). The neo daemon reads only MCP's standard tool
annotations to decide whether to ask before a call: `readOnlyHint: true` is a read and never
asks; `destructiveHint: false` is an edit that lands in Latent's undo history, so the
`undo` tool (or the user's Ctrl+Z) takes it back; a tool with neither (`export`, the merges)
cannot be taken back, and the daemon asks before it runs in every mode but auto. Undo stays
here: there is no revert tool and no result `_meta`.

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
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.utilities.types import Image
from mcp.types import ToolAnnotations

_READS = ToolAnnotations(read_only_hint=True)
# An edit that goes through the op-stack's one write path, so it is a history step.
_UNDOABLE = ToolAnnotations(destructive_hint=False)

# What the agent is told about Latent, wherever it was started: in Latent's Assistant or in a
# terminal that moved into Latent. The Assistant's messages carry a <selection>; jobs it waits on
# come back as <jobs_finished>.
INSTRUCTIONS = """Latent is a raw photo editor. Its edits are an ordered op-stack per photo.

- The tools act on the photo open in Latent, which the user is looking at. When the user names a photo, find it with find_photos (a search over file name and camera) and open it with open_photo, so Latent shows it, then work on it. For a batch, do that for each photo in turn: open_photo, edit, check with render_preview, next photo. Pass photo_id to a tool when the photo is not the one you opened last.
- Read a photo's stack with get_stack. Change it only with run_python, against the `latent` module. Every run_python call carries an `explanation`: one plain sentence the user reads instead of your code, saying what the script does and why. Look at the result with render_preview; pass mask=["<op id>"] to see a layer's mask.
- Every edit is a step in the photo's undo history. To take back a change you made, call undo once per step.
- A <selection> with a box is a region in image space: [x0, y0, x1, y1], 0..1 over the uncropped photo, the space masks use. whole_photo="true" means the request is about the entire photo.
- A whole-photo change goes on the stack directly: `latent.photo.stack.add("vibrance", value=20)`, or the develop settings: `latent.photo.develop.exposure = 0.3`.
- A local change is one layer: `layer = latent.photo.stack.group()`, a mask on it, adjustments inside it. Mask the selected thing with `cid = layer.mask.add("objects", box=[x0, y0, x1, y1])` then `latent.photo.masks.detect(layer.id, cid)`, or name it: `layer.mask.add("text", prompt="dragon")` and detect. Then add adjustments: `layer.add("exposure", value=-0.6)`. Op names and ranges follow Lightroom: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, texture, clarity, dehaze.
- Adding, replacing or removing content is generative: generative_fill (repaint from a prompt) and generative_remove (erase). Call generative_status first; if ComfyUI is not running, say so instead of trying. For a named thing pass select="the cat". For a selected box, make the op yourself with run_python: `op = latent.photo.stack.add("generative_fill", prompt="...", seed=0, model="")` (or "remove" without a prompt), `cid = op.mask.add("objects", box=[...])`, `latent.photo.masks.detect(op.id, cid)`; once the component is ready, call the tool with op_id.
- Mask detection, generative fill and remove, and depth estimates run as background jobs. Never poll for them. Once you have started one in Latent's Assistant, end your turn with one short sentence saying what you are waiting for: when every job has finished you get a message <jobs_finished>…</jobs_finished> saying how each went, and carry on from there.
- Images attached after a selection are references from the user (a look to match, an object to add), not the photo being edited.
- Keep one request in one layer, and adjust it rather than stacking new ones. Do not export, merge, or touch photos the user did not ask about.
- For tone (exposure, contrast, clipping, "too dark", "blown out"), read get_histogram before and after: its zones map onto the blacks, shadows, exposure, highlights and whites ops.
- render_preview takes region=[x0, y0, x1, y1] in image space and renders it from the full-resolution photo. Zoom in to judge detail, noise or an edge, and to compare a part of the photo with a reference image.
- Check the result with render_preview before you answer. Answers in Latent's Assistant are one or two short sentences."""

server = MCPServer("latent", instructions=INSTRUCTIONS)


@server.tool(annotations=_UNDOABLE)
def run_python(code: str, explanation: str, photo_id: int | None = None) -> dict[str, Any]:
    """Run Python against the live engine. The `latent` module is already imported.

    `explanation` is shown to the user in place of the code: one short sentence, in plain
    words, saying what the script does and why — "Pull the highlights down to recover the
    clouds", not "Set highlights.value". Required.

    The last expression's repr comes back as `value`; stdout and stderr are captured.
    Examples: `latent.photo.develop.exposure = 0.7`, `latent.photo.stack.add("vibrance",
    value=20)`, `latent.undo()`, `latent.photo.stack_json()`.
    """
    # Only the user reads it; the engine has no use for it.
    del explanation
    # The tool name rides along so stack.changed reaches the UI as client "mcp:run_python".
    return latent._run_code(code, photo_id, tool="run_python")


@server.tool(annotations=_UNDOABLE)
def undo(photo_id: int | None = None) -> dict[str, Any]:
    """Undo the photo's last history step, the same as Ctrl+Z in the editor.

    An edit is one or more steps: call this once per step to take a change back, and look at
    `get_stack` or `render_preview` in between. `undone` is false when there was nothing left.
    """
    photo = None
    if photo_id is not None:
        open_photos = latent.photos()
        photo = next((open_photo for open_photo in open_photos if open_photo.id == photo_id), None)
        if photo is None:
            raise ToolError(f"photo {photo_id} is not open")
    undone = latent.undo(photo)
    state = latent._stack_state(photo_id)
    return {"photoId": state["photoId"], "undone": undone, "canUndo": state["canUndo"]}


@server.tool(annotations=_READS)
def get_stack(photo_id: int | None = None) -> dict[str, Any]:
    """The photo's op-stack, revision, undo state, histogram and clipping percentages."""
    return latent._stack_state(photo_id)


# Lightroom splits its histogram into five regions, each moved by the slider of that name,
# so an agent reading these knows which op to reach for. Bounds are 8-bit levels.
_ZONES = (
    ("blacks", 0, 26),
    ("shadows", 26, 77),
    ("exposure", 77, 179),
    ("highlights", 179, 230),
    ("whites", 230, 256),
)
_COARSE_BUCKETS = 32


def _channel_summary(bins: list[int]) -> dict[str, Any]:
    total = sum(bins)
    if total == 0:
        return {}
    percentiles: dict[str, float] = {}
    targets = [("p1", 0.01), ("p5", 0.05), ("p50", 0.5), ("p95", 0.95), ("p99", 0.99)]
    running = 0
    for level, count in enumerate(bins):
        running += count
        while targets and running >= targets[0][1] * total:
            percentiles[targets.pop(0)[0]] = round(level / 255, 3)
    width = len(bins) // _COARSE_BUCKETS
    return {
        "mean": round(sum(level * count for level, count in enumerate(bins)) / total / 255, 3),
        "percentiles": percentiles,
        "zonesPct": {
            name: round(100 * sum(bins[low:high]) / total, 1) for name, low, high in _ZONES
        },
        "bucketsPct": [
            round(100 * sum(bins[start : start + width]) / total, 1)
            for start in range(0, len(bins), width)
        ],
    }


@server.tool(annotations=_READS)
def get_histogram(photo_id: int | None = None) -> dict[str, Any]:
    """The histogram of the photo as the viewer last drew it, display-referred (0 black, 1 white).

    Per channel r, g, b: `mean`, `percentiles` (p1…p99 as 0..1 levels), `zonesPct` — the
    share of pixels in Lightroom's five regions, blacks/shadows/exposure/highlights/whites,
    each moved by the op of that name — and `bucketsPct`, 32 equal-width buckets from black
    to white. `clipping` is the share of pixels crushed to black or blown to white. Read it
    after an edit to check tone, instead of guessing from a preview.
    """
    state = latent._stack_state(photo_id)
    histogram = state.get("histogram") or {}
    return {
        "channels": {
            channel: _channel_summary(histogram.get(channel) or []) for channel in ("r", "g", "b")
        },
        "clipping": state.get("clipping", {}),
    }


@server.tool(annotations=_READS)
def render_preview(
    photo_id: int | None = None,
    max_size: int = 1024,
    mask: list[str] | None = None,
    region: list[float] | None = None,
) -> Image:
    """A JPEG of the photo's current state, long edge at most `max_size`.

    Pass `region=[x0, y0, x1, y1]` to zoom in: image space, 0..1 over the uncropped photo —
    the same box a <selection> gives you. It is rendered from the full-resolution photo, so
    a small region shows real detail; use it to judge texture, noise, an edge or a colour
    up close, or to compare a part of the photo against a reference image.

    Pass `mask=["<op_id>"]` to get that op's combined mask instead, as a greyscale PNG
    (white = the op applies, black = it does not), or `mask=["<op_id>", "<component_id>"]`
    for one component's raster. That is how to check what a selection actually caught.
    """
    if mask:
        component_id = mask[1] if len(mask) > 1 else None
        raster = latent._preview_mask_png(photo_id, mask[0], component_id, max_size)
        return Image(data=raster, format="png")
    return Image(data=latent._preview_jpeg(photo_id, max_size, region), format="jpeg")


@server.tool(annotations=_READS)
def list_photos() -> list[dict[str, Any]]:
    """The catalog's photos, newest import first, at most 200. To find a named photo, use
    find_photos instead."""
    return latent._list_photos()


@server.tool(annotations=_READS)
def find_photos(query: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """Search the catalog the way the Library's search box does: photos whose file name or
    camera contains `query`, case-insensitive; an empty `query` lists everything. Newest
    capture first.

    Returns `{photos, total}`. Each photo has `photoId`, `filename`, `path`, `camera`,
    `capturedAt` and `open` (whether the engine has it open, which the other tools need).
    `total` counts every match, so when it is more than `limit` pass `offset` for the next
    page. Open a match with `open_photo`.
    """
    return latent._find_photos(query, max(1, min(limit, 200)), max(0, offset))


# Reads, by the harness contract: it changes no photo. It does change what the user is looking
# at, which is the point, and is not something undo takes back.
@server.tool(annotations=_READS)
def open_photo(photo_id: int | None = None, path: str | None = None) -> dict[str, Any]:
    """Open a photo and show it to the user: Latent switches to it. Pass the `photoId` of a
    `find_photos` match, or the `path` of a file that is not catalogued yet.

    From then on the photo is the open one, so tools called without a `photo_id` act on it.
    Opening a photo that is already open just moves the user back to it. Returns the photo's
    `photoId`, `filename`, `path`, `width` and `height`.
    """
    if (photo_id is None) == (path is None):
        raise ToolError("pass either photo_id or path")
    opened = latent._show_photo(photo_id, path)
    photo = next(candidate for candidate in latent.photos() if candidate.id == opened)
    return {
        "photoId": photo.id,
        "filename": photo.filename,
        "path": photo.path,
        "width": photo.width,
        "height": photo.height,
    }


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


@server.tool(annotations=_UNDOABLE)
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


@server.tool(annotations=_UNDOABLE)
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


@server.tool(annotations=_READS)
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
def merge_star_trail(
    photo_ids: list[int],
    blend: str = "lighten",
    gap_fill: int = 0,
    foreground: str = "lighten",
    foreground_threshold: float = 2,
    decay: float = 0,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Stack 2 to 500 night frames, in shooting order, into one star trail photo.

    Returns `{jobId}`; `result.photoId` arrives on the job's last job.progress. `blend` is
    lighten (the brightest frame per pixel, which is what draws the trails) or average (one
    long exposure with less noise and no trails). There is no alignment: the sequence is
    assumed to be on a tripod, because registering it would straighten the trails.

    `gap_fill` (0-8) bridges the camera's write time between frames, `foreground`
    ("lighten" / "firstFrame") decides whether the ground collects every frame's noise, and
    `decay` (0-100) fades the older end of each trail into a comet tail.
    """
    return latent.merge.star_trail(
        photo_ids,
        blend=blend,
        gap_fill=gap_fill,
        foreground=foreground,
        foreground_threshold=foreground_threshold,
        decay=decay,
        output_path=output_path,
    )


@server.tool(annotations=_READS)
def merge_preview(kind: str, photo_ids: list[int], long_edge: int = 1024) -> dict[str, Any]:
    """The same merge from the embedded JPEGs: seconds, a PNG, and no catalog row.

    `kind` is hdr / panorama / hdrPanorama / starTrail. The job's last job.progress carries
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
