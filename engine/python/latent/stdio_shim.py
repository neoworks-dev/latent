"""`latent mcp`: a stdio MCP server that proxies to the running daemon.

Clients that only speak stdio (and Claude Code's `claude mcp add` default) get this; it
forwards tools/list and tools/call to latentd's streamable-HTTP endpoint, whose port the
daemon writes to ~/.config/latent/mcp.port at startup and removes at exit.

Run it with the bundled interpreter: `python3.12 -m latent.stdio_shim`, or through
engine/scripts/latent-mcp which finds that interpreter for you.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import anyio
import mcp.types as types
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server


def port_file() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    base = Path(config_home) if config_home else Path.home() / ".config"
    return base / "latent" / "mcp.port"


def endpoint() -> str:
    override = os.environ.get("LATENT_MCP_URL")
    if override:
        return override
    port = os.environ.get("LATENT_MCP_PORT")
    if not port:
        path = port_file()
        if not path.exists():
            raise SystemExit(f"latent: no daemon port at {path} — is latentd running?")
        port = path.read_text().strip()
    return f"http://127.0.0.1:{port}/mcp"


async def serve(url: str) -> None:
    async with streamable_http_client(url) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as upstream:
            await upstream.initialize()
            await _bridge(upstream)


async def _bridge(upstream: ClientSession) -> None:
    async def on_list_tools(_ctx: object, _params: object) -> types.ListToolsResult:
        return types.ListToolsResult(tools=(await upstream.list_tools()).tools)

    async def on_call_tool(_ctx: object, params: types.CallToolRequestParams) -> types.CallToolResult:
        return await upstream.call_tool(params.name, params.arguments or {})

    proxy = Server("latent", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
    async with stdio_server() as (read_stream, write_stream):
        await proxy.run(read_stream, write_stream, proxy.create_initialization_options())


def main() -> None:
    try:
        anyio.run(serve, endpoint())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
