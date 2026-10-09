# latent_ops is pure: op registry, stack, history, sidecars, and the histogram of a frame
# somebody else rendered. No GPU, no sockets, so the Catch2 tests link it directly and run
# on a machine without a device.
add_library(latent_ops STATIC
  ops/curve.cpp
  ops/geometry.cpp
  ops/history.cpp
  ops/history_diff.cpp
  ops/mask.cpp
  ops/mask_raster.cpp
  ops/op.cpp
  ops/registry.cpp
  ops/sha256.cpp
  ops/sidecar.cpp
  pipeline/histogram.cpp)
target_include_directories(latent_ops PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_ops PUBLIC nlohmann_json::nlohmann_json)

# latent_ai is the onnxruntime half: the mask models and the pixel/token arithmetic they
# need. No GPU (wgpu) involvement — the sessions run on the same worker thread the request
# already sits on. Anything that links it needs ORT_LIB_DIR on its RPATH, because the CUDA
# provider .so is dlopen'd next to libonnxruntime.so at session creation.
add_library(latent_ai STATIC
  ai/bpe_tokenizer.cpp
  ai/dedicated.cpp
  ai/denoise.cpp
  ai/depth.cpp
  ai/florence2.cpp
  ai/mask_detect.cpp
  ai/model_store.cpp
  ai/ort_session.cpp
  ai/preprocess.cpp
  ai/sam2.cpp
  ai/trails.cpp)
target_include_directories(latent_ai PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_ai PUBLIC latent_ops onnxruntime)

# latent_catalog is the other headless half: SQLite, LibRaw metadata, JPEG, and the PNG/JPEG
# importer (libexif for EXIF, lcms2 for the ICC profile). The catalog tests link it without
# pulling in a GPU device.
add_library(latent_catalog STATIC
  catalog/catalog.cpp
  catalog/preview.cpp
  catalog/thumbnail.cpp
  catalog/watcher.cpp
  image/import_image.cpp
  image/jpeg.cpp
  image/png.cpp
  jobs/worker.cpp
  raw/raw_metadata.cpp)
target_link_libraries(latent_catalog PUBLIC latent_ops latent_ai unofficial::sqlite3::sqlite3
  PkgConfig::LIBRAW PNG::PNG TIFF::TIFF unofficial::libexif::libexif lcms2::lcms2
  $<IF:$<TARGET_EXISTS:libjpeg-turbo::turbojpeg>,libjpeg-turbo::turbojpeg,libjpeg-turbo::turbojpeg-static>)

# latent_export is the encoders, the output colour transform and the job runner. No GPU:
# it takes a finished 16-bit buffer and turns it into a file, so the encoder tests run
# without a device and the renderer can depend on it for Rgb16Image.
add_library(latent_export STATIC
  export/color_space.cpp
  export/encoder.cpp
  export/export_job.cpp
  export/export_options.cpp)
target_include_directories(latent_export PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_export PUBLIC latent_ops latent_catalog TIFF::TIFF PNG::PNG
  lcms2::lcms2)
if(TARGET avif)
  target_link_libraries(latent_export PUBLIC avif)
  target_compile_definitions(latent_export PUBLIC LATENT_HAVE_AVIF)
else()
  message(WARNING "libavif not found: latentd will refuse AVIF exports")
endif()

# latent_merge is Photo Merge: alignment, the HDR estimate, the stitch, and the 16-bit
# TIFF the merged image becomes. Deliberately free of decode_raw — it is handed finished
# frames — so it stays out of latent_core's dependency cycle and its tests run headless.
add_library(latent_merge STATIC
  merge/align.cpp
  merge/frame_info.cpp
  merge/hdr.cpp
  merge/merge.cpp
  merge/merge_image.cpp
  merge/pano.cpp
  merge/source_image.cpp
  merge/startrail.cpp)
target_include_directories(latent_merge PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_merge PUBLIC latent_ops latent_catalog PkgConfig::LIBRAW TIFF::TIFF)

# latent_generative is the model-raster half (PROMPT.md 3.5): the op-stack arithmetic behind
# a cached raster, the graphs Latent ships, the colour PNG codec the crop and the result move
# as, and the backends. No GPU (wgpu) and no sockets — it spawns the `comfy` CLI, or runs the
# local denoise graph through latent_ai — so the generative tests run headless with the stub
# backend.
add_library(latent_generative STATIC
  generative/comfy_backend.cpp
  generative/comfy_cli.cpp
  generative/generative.cpp
  generative/image_io.cpp
  generative/onnx_backend.cpp
  generative/sky_backend.cpp
  generative/stub_backend.cpp
  generative/workflow.cpp)
target_include_directories(latent_generative PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_generative PUBLIC latent_ops latent_ai latent_catalog PNG::PNG)
target_compile_definitions(latent_generative PRIVATE
  LATENT_WORKFLOW_DIR="${CMAKE_SOURCE_DIR}/workflows")

# Python home = the vcpkg install prefix (…/lib/python3.12 is Python3_STDLIB).
get_filename_component(LATENT_PYTHON_HOME "${Python3_STDLIB}/../.." ABSOLUTE)

add_library(latent_core STATIC
  gpu/gpu.cpp
  pipeline/renderer.cpp
  python/interpreter.cpp
  python/json_convert.cpp
  python/module.cpp
  raw/raw_decode.cpp
  server/server.cpp
  server/shared_frame.cpp)
target_link_libraries(latent_core PUBLIC latent_ops latent_catalog latent_export latent_merge
  latent_generative wgpu_native PkgConfig::LIBRAW unofficial::uwebsockets::uwebsockets
  pybind11::embed)
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
  ${CMAKE_SOURCE_DIR}/shaders/mask_combine.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/export.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/composite.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/blend.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/relight.wgsl)

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
# Nothing else may be: -rdynamic alone also exported every static vcpkg archive, and a
# shared library loaded later binds to the executable first — libcudnn_graph.so took our
# zlib's `inflate`/`inflateInit2_` instead of the system's and segfaulted decompressing its
# runtime-compiled kernels (Florence-2 in the daemon, never in a probe without -rdynamic).
# Every archive except libpython stays private.
target_link_options(latentd PRIVATE -rdynamic
  "-Wl,--exclude-libs,libz.a:liblzma.a:libbz2.a:libjpeg.a:libturbojpeg.a:libpng16.a:libpng.a:libtiff.a:libaom.a:libavif.a:libyuv.a:liblcms2.a:libcrypto.a:libssl.a:libexpat.a:libffi.a:libuuid.a:libb2.a:libjasper.a:libraw_r.a:libsqlite3.a:libuSockets.a:libexif.a")
# apps/desktop looks for engine/build/dev/latentd, so the binary sits in the build root.
set_target_properties(latentd PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
  BUILD_RPATH "${ORT_LIB_DIR}" INSTALL_RPATH "${ORT_LIB_DIR}")
