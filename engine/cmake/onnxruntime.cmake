# onnxruntime with the CUDA execution provider. vcpkg's port builds ORT from source
# (hours) and has no CUDA EP, so the official prebuilt GPU tarball is used instead,
# pinned here and unpacked into third_party/onnxruntime (gitignored).
# Requires the CUDA 13 toolkit and cuDNN 9 on the machine (pacman: cuda, cudnn).

set(ORT_VERSION "1.30.0")
set(ORT_DIR "${CMAKE_CURRENT_LIST_DIR}/../third_party/onnxruntime")
set(ORT_URL
    "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-gpu_cuda13-${ORT_VERSION}.tgz")

if(NOT EXISTS "${ORT_DIR}/include/onnxruntime_cxx_api.h")
  message(STATUS "Fetching onnxruntime ${ORT_VERSION} (cuda13)")
  file(MAKE_DIRECTORY "${ORT_DIR}")
  file(DOWNLOAD "${ORT_URL}" "${ORT_DIR}/ort.tgz" STATUS download_status)
  list(GET download_status 0 download_code)
  if(NOT download_code EQUAL 0)
    message(FATAL_ERROR "onnxruntime download failed: ${download_status}")
  endif()
  file(ARCHIVE_EXTRACT INPUT "${ORT_DIR}/ort.tgz" DESTINATION "${ORT_DIR}")
  file(REMOVE "${ORT_DIR}/ort.tgz")
  # The tarball nests everything under onnxruntime-linux-x64-gpu_cuda13-<ver>/; flatten it.
  file(GLOB ORT_NESTED "${ORT_DIR}/onnxruntime-linux-x64-gpu*")
  list(GET ORT_NESTED 0 ORT_NESTED_DIR)
  file(RENAME "${ORT_NESTED_DIR}/include" "${ORT_DIR}/include")
  file(RENAME "${ORT_NESTED_DIR}/lib" "${ORT_DIR}/lib")
  file(REMOVE_RECURSE "${ORT_NESTED_DIR}")
endif()

add_library(onnxruntime SHARED IMPORTED GLOBAL)
set_target_properties(onnxruntime PROPERTIES
  IMPORTED_LOCATION "${ORT_DIR}/lib/libonnxruntime.so"
  INTERFACE_INCLUDE_DIRECTORIES "${ORT_DIR}/include")
# The CUDA provider .so is dlopen'd by ORT at session creation; it must sit next to
# libonnxruntime.so at runtime, which it does inside third_party/onnxruntime/lib.
set(ORT_LIB_DIR "${ORT_DIR}/lib" CACHE INTERNAL "onnxruntime runtime library directory")
