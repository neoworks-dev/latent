add_library(probe_gpu_common STATIC gpu.cpp)
target_include_directories(probe_gpu_common PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(probe_gpu_common PUBLIC wgpu_native)

add_executable(probe_gpu probe_gpu.cpp)
target_link_libraries(probe_gpu PRIVATE probe_gpu_common)

add_executable(probe_raw probe_raw.cpp raw_decode.cpp)
target_link_libraries(probe_raw PRIVATE PkgConfig::LIBRAW PNG::PNG)

# Python home = the vcpkg install prefix (…/lib/python3.12 is Python3_STDLIB).
get_filename_component(LATENT_PYTHON_HOME "${Python3_STDLIB}/../.." ABSOLUTE)
add_executable(probe_python probe_python.cpp)
target_link_libraries(probe_python PRIVATE pybind11::embed)
target_compile_definitions(probe_python PRIVATE LATENT_PYTHON_HOME="${LATENT_PYTHON_HOME}")
# libpython is linked statically; extension modules (pydantic_core etc.) dlopen'd by the
# interpreter resolve CPython symbols against the executable, so they must be exported.
target_link_options(probe_python PRIVATE -rdynamic)

add_executable(probe_onnx probe_onnx.cpp)
target_link_libraries(probe_onnx PRIVATE onnxruntime)
set_target_properties(probe_onnx PROPERTIES BUILD_RPATH "${ORT_LIB_DIR}")

add_executable(probe_florence probe_florence.cpp)
target_link_libraries(probe_florence PRIVATE latent_ai latent_catalog)
set_target_properties(probe_florence PROPERTIES BUILD_RPATH "${ORT_LIB_DIR}")

add_executable(probe_frame probe_frame.cpp raw_decode.cpp)
target_link_libraries(probe_frame PRIVATE probe_gpu_common PkgConfig::LIBRAW PNG::PNG
  nlohmann_json::nlohmann_json unofficial::uwebsockets::uwebsockets)
