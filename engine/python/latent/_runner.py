"""REPL semantics for `python.run`: execute the block, evaluate a trailing expression.

`latent` itself is the C++ module (pybind11, embedded in latentd); this file is one of its
submodules, reachable because the engine sets `latent.__path__` at startup.
"""

from __future__ import annotations

import ast
import builtins
import contextlib
import io
import traceback
from collections.abc import Callable
from typing import Any

import latent

_FILENAME = "<latent>"


class _Tee(io.TextIOBase):
    """Collects everything written and forwards each chunk to the engine as it arrives.

    The engine turns the forwarded chunks into `python.output` notifications, so a console
    sees a long script's prints while it still runs. The collected text is what the
    `python.run` result carries, so the two never disagree.
    """

    def __init__(self, stream: str, emit: Callable[[str, str], None] | None):
        self._stream = stream
        self._emit = emit
        self._collected = io.StringIO()

    def write(self, text: str) -> int:
        self._collected.write(text)
        if self._emit is not None and text:
            self._emit(self._stream, text)
        return len(text)

    def writable(self) -> bool:
        return True

    def getvalue(self) -> str:
        return self._collected.getvalue()


def run(code: str, emit: Callable[[str, str], None] | None = None) -> dict[str, Any]:
    """Run `code` in a fresh globals dict. Never raises: failures come back in the dict."""
    scope: dict[str, Any] = {
        "__name__": "__latent__",
        "__builtins__": builtins,
        "latent": latent,
    }
    out, err = _Tee("stdout", emit), _Tee("stderr", emit)
    value: str | None = None
    ok = True
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            value = _execute(code, scope)
    except BaseException:  # noqa: BLE001 - a script may raise anything, including SystemExit
        ok = False
        # Written through the tee so a streaming console sees the traceback too.
        err.write(traceback.format_exc())
    return {"ok": ok, "stdout": out.getvalue(), "stderr": err.getvalue(), "value": value}


def _execute(code: str, scope: dict[str, Any]) -> str | None:
    tree = ast.parse(code, _FILENAME, "exec")
    last = tree.body[-1] if tree.body else None
    if not isinstance(last, ast.Expr):
        exec(compile(tree, _FILENAME, "exec"), scope)  # noqa: S102 - running code is the point
        return None
    head = ast.Module(body=tree.body[:-1], type_ignores=[])
    exec(compile(head, _FILENAME, "exec"), scope)  # noqa: S102
    result = eval(compile(ast.Expression(body=last.value), _FILENAME, "eval"), scope)  # noqa: S307
    return None if result is None else repr(result)
