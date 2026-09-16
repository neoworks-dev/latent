"""What the generative MCP tools run inside the engine (PROMPT.md 3.5).

`mcp_server` reaches the op-stack the way every other write does — through
`latent._run_code`, which hops onto the server thread — so everything here runs *on* that
thread. Nothing may block on a job: the worker posts its result back to this same thread,
so waiting here would deadlock. A tool therefore starts work and answers with job ids; the
agent watches `get_stack`.
"""

from __future__ import annotations

import json
from typing import Any

import latent


def _find(photo: Any, op_id: str) -> Any:
    for op in photo.stack:
        if op.id == op_id:
            return op
    raise ValueError(f"unknown opId {op_id!r}")


def start(
    op_name: str,
    prompt: str = "",
    select: str | None = None,
    op_id: str | None = None,
    seed: int = 0,
    model: str = "",
) -> dict[str, Any]:
    """Add (or find) a generative op and run it.

    With `select`, the region is chosen by a text mask — Florence-2 finds the box, SAM 2
    cuts it out — which is a job of its own. That job has to land before there is anything
    to repaint, so this returns its id and the caller comes back with `op_id`.
    """
    photo = latent.photo
    if op_id is not None:
        op = _find(photo, op_id)
    else:
        params: dict[str, Any] = {"seed": int(seed), "model": model}
        if op_name == "generative_fill":
            params["prompt"] = prompt
        op = photo.stack.add(op_name, **params)
        if select:
            component = op.mask.add("text", prompt=select)
            return {
                "opId": op.id,
                "componentId": component,
                "maskJobId": photo.masks.detect(op.id, component),
                "next": (
                    "the selection is running; once get_stack shows the component `ready`, "
                    f"call this tool again with op_id={op.id!r}"
                ),
            }

    if len(op.mask) == 0:
        return {
            "opId": op.id,
            "error": "the op has no mask, and the mask is the region to repaint",
            "next": "pass `select` to choose one by text, or paint one in the UI",
        }
    return {"opId": op.id, "jobId": op.run(), "stale": op.stale}


def emit(op_name: str, **arguments: Any) -> None:
    """`start`, printed as JSON — `_run_code` hands stdout back to the tool."""
    print(json.dumps(start(op_name, **arguments)))
