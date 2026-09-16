# latent_ops is pure: op registry, stack, history, sidecars. No GPU, no sockets, so the
# Catch2 tests link it directly and run on a machine without a device.
add_library(latent_ops STATIC
  ops/history.cpp
  ops/op.cpp
  ops/registry.cpp
  ops/sha256.cpp
  ops/sidecar.cpp)
target_include_directories(latent_ops PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(latent_ops PUBLIC nlohmann_json::nlohmann_json)

add_library(latent_core STATIC
  gpu/gpu.cpp
  pipeline/histogram.cpp
  pipeline/renderer.cpp
  raw/raw_decode.cpp
  server/server.cpp)
target_link_libraries(latent_core PUBLIC latent_ops wgpu_native PkgConfig::LIBRAW
  unofficial::uwebsockets::uwebsockets)
latent_embed_shaders(latent_core
  ${CMAKE_SOURCE_DIR}/shaders/linearize.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/downscale.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/ops.wgsl
  ${CMAKE_SOURCE_DIR}/shaders/display.wgsl)

add_executable(latentd main.cpp)
target_link_libraries(latentd PRIVATE latent_core)
# apps/desktop looks for engine/build/dev/latentd, so the binary sits in the build root.
set_target_properties(latentd PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
