#!/bin/sh
# Installs what the embedded interpreter needs that vcpkg does not ship: the official MCP
# Python SDK. Called from the build (see engine/src/CMakeLists.txt) with the bundled
# interpreter's path, so a clean checkout gets a working MCP server without a manual step.
#
#   engine/scripts/install-python-deps.sh build/dev/vcpkg_installed/x64-linux/tools/python3/python3.12
#
# A failure here (no network, mirror down) is a warning, never a build error: latentd runs
# fine without MCP and says so on startup.
set -eu

python=${1:-}
if [ -z "$python" ] || [ ! -x "$python" ]; then
  echo "install-python-deps: no interpreter at '${python}'" >&2
  exit 0
fi

if "$python" -c "import mcp" >/dev/null 2>&1; then
  exit 0
fi

echo "install-python-deps: installing mcp into $python"
if ! "$python" -m pip install --disable-pip-version-check --quiet "mcp==2.2.0"; then
  echo "install-python-deps: pip failed; latentd will start without the MCP server" >&2
fi
exit 0
