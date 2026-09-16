"""The `latent` package.

Inside latentd this name is already taken by the pybind11 module compiled into the daemon
(engine/src/python/module.cpp); the engine only points its ``__path__`` here so the
submodules below load. This file therefore runs **only** when a plain CPython imports the
package from outside the daemon — the `latent mcp` stdio shim is the one case — and it must
not import anything that exists solely in the engine.
"""

__all__ = ["_generative", "merge", "mcp_server", "stdio_shim"]
