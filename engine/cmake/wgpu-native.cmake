# wgpu-native is not in vcpkg. A pinned prebuilt release is unpacked into
# third_party/wgpu-native (gitignored) and exposed as an imported target.
# Bump the version here and delete the directory to upgrade.

set(WGPU_NATIVE_VERSION "v29.0.1.1")
set(WGPU_NATIVE_DIR "${CMAKE_CURRENT_LIST_DIR}/../third_party/wgpu-native")
set(WGPU_NATIVE_URL
    "https://github.com/gfx-rs/wgpu-native/releases/download/${WGPU_NATIVE_VERSION}/wgpu-linux-x86_64-release.zip")

if(NOT EXISTS "${WGPU_NATIVE_DIR}/include/webgpu/webgpu.h")
  message(STATUS "Fetching wgpu-native ${WGPU_NATIVE_VERSION}")
  file(MAKE_DIRECTORY "${WGPU_NATIVE_DIR}")
  file(DOWNLOAD "${WGPU_NATIVE_URL}" "${WGPU_NATIVE_DIR}/wgpu.zip" STATUS download_status)
  list(GET download_status 0 download_code)
  if(NOT download_code EQUAL 0)
    message(FATAL_ERROR "wgpu-native download failed: ${download_status}")
  endif()
  file(ARCHIVE_EXTRACT INPUT "${WGPU_NATIVE_DIR}/wgpu.zip" DESTINATION "${WGPU_NATIVE_DIR}")
  file(REMOVE "${WGPU_NATIVE_DIR}/wgpu.zip")
endif()

add_library(wgpu_native STATIC IMPORTED GLOBAL)
set_target_properties(wgpu_native PROPERTIES
  IMPORTED_LOCATION "${WGPU_NATIVE_DIR}/lib/libwgpu_native.a"
  INTERFACE_INCLUDE_DIRECTORIES "${WGPU_NATIVE_DIR}/include")
# The static archive is Rust; it needs these system libs to link.
target_link_libraries(wgpu_native INTERFACE dl pthread m)
