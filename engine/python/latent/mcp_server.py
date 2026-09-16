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
def render_preview(photo_id: int | None = None, max_size: int = 1024) -> Image:
    """A JPEG of the photo's current state, long edge at most `max_size`."""
    return Image(data=latent._preview_jpeg(photo_id, max_size), format="jpeg")


@server.tool()
def list_photos() -> list[dict[str, Any]]:
    """The catalog's photos, newest import first."""
    return latent._list_photos()


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
