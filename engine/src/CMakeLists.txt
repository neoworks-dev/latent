# latent_ops is pure: op registry, stack, history, sidecars. No GPU, no sockets, so the
# Catch2 tests link it directly and run on a machine without a device.
add_library(latent_ops STATIC
  ops/curve.cpp
  ops/history.cpp
  ops/mask.cpp
  ops/mask_raster.cpp
  ops/op.cpp
  ops/registry.cpp
  ops/sha256.cpp
  ops/sidecar.cpp)
target_include_directories(latent_ops PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_ops PUBLIC nlohmann_json::nlohmann_json)

# latent_catalog is the other headless half: SQLite, LibRaw metadata, JPEG. The catalog
# tests link it without pulling in a GPU device.
add_library(latent_catalog STATIC
  ai/mask_detect.cpp
  catalog/catalog.cpp
  catalog/thumbnail.cpp
  image/jpeg.cpp
  image/png.cpp
  jobs/worker.cpp
  raw/raw_metadata.cpp)
target_link_libraries(latent_catalog PUBLIC latent_ops unofficial::sqlite3::sqlite3
  PkgConfig::LIBRAW PNG::PNG
  $<IF:$<TARGET_EXISTS:libjpeg-turbo::turbojpeg>,libjpeg-turbo::turbojpeg,libjpeg-turbo::turbojpeg-static>)

# Python home = the vcpkg install prefix (…/lib/python3.12 is Python3_STDLIB).
get_filename_component(LATENT_PYTHON_HOME "${Python3_STDLIB}/../.." ABSOLUTE)

add_library(latent_core STATIC
  gpu/gpu.cpp
  pipeline/histogram.cpp
  pipeline/renderer.cpp
  python/interpreter.cpp
  python/json_convert.cpp
  python/module.cpp
  raw/raw_decode.cpp
  server/server.cpp)
target_link_libraries(latent_core PUBLIC latent_ops latent_catalog wgpu_native PkgConfig::LIBRAW
  unofficial::uwebsockets::uwebsockets pybind11::embed)
target_compile_definitions(latent_core PRIVATE
  LATENT_PYTHON_HOME="${LATENT_PYTHON_HOME}"
  LATENT_PYTHON_PACKAGE_DIR="${CMAKE_SOURCE_DIR}/python/latent")
latent_embed_shaders(latent_core
  ${CMAKE_SOURCE_DIR}/shaders/linearize.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/downscale.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/ops.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/blur.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/neighborhood.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/display.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/mask.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/mask_combine.wgsl)

# The MCP SDK is pip-installed into the bundled interpreter; vcpkg has no port for it.
# The stamp keeps it to once per build directory, and the script never fails the build.
set(LATENT_PYTHON_DEPS_STAMP "${CMAKE_BINARY_DIR}/python-deps.stamp")
add_custom_command(
  OUTPUT "${LATENT_PYTHON_DEPS_STAMP}"
  COMMAND "${CMAKE_SOURCE_DIR}/scripts/install-python-deps.sh" "${Python3_EXECUTABLE}"
  COMMAND ${CMAKE_COMMAND} -E touch "${LATENT_PYTHON_DEPS_STAMP}"
  DEPENDS "${CMAKE_SOURCE_DIR}/scripts/install-python-deps.sh"
  COMMENT "installing the MCP Python SDK into the bundled interpreter"
  VERBATIM)
add_custom_target(latent_python_deps DEPENDS "${LATENT_PYTHON_DEPS_STAMP}")

add_executable(latentd main.cpp)
target_link_libraries(latentd PRIVATE latent_core)
add_dependencies(latentd latent_python_deps)
# libpython is linked statically; extension modules (pydantic_core etc.) dlopen'd by the
# interpreter resolve CPython symbols against the executable, so they must be exported.
target_link_options(latentd PRIVATE -rdynamic)
# apps/desktop looks for engine/build/dev/latentd, so the binary sits in the build root.
set_target_properties(latentd PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
