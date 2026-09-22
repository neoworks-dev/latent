cmake_minimum_required(VERSION 3.25)
project(latent_engine LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

include(cmake/wgpu-native.cmake)
include(cmake/format.cmake)
include(cmake/embed_shaders.cmake)

find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBRAW REQUIRED IMPORTED_TARGET libraw)
# libraw[openmp] parallelises demosaic, scale_colors and convert_to_rgb — 983 ms -> 258 ms
# of a 24 MP decode on 16 cores. Its own .pc file does not mention the runtime, so the
# static libraw_r.a arrives with undefined GOMP_* symbols and has to be told here.
#
# Not find_package(OpenMP): that asks whether *our* compiler can compile OpenMP, and this
# build is clang without libomp installed. Nothing in engine/ has an omp pragma — only the
# archive vcpkg built with gcc does, so all that is needed is gcc's runtime beside it.
find_library(GOMP_LIBRARY NAMES gomp REQUIRED)
target_link_libraries(PkgConfig::LIBRAW INTERFACE ${GOMP_LIBRARY})
find_package(PNG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(unofficial-uwebsockets CONFIG REQUIRED)
find_package(unofficial-sqlite3 CONFIG REQUIRED)
find_package(libjpeg-turbo CONFIG REQUIRED)
find_package(TIFF REQUIRED)
find_package(lcms2 CONFIG REQUIRED)
find_package(unofficial-libexif CONFIG REQUIRED)
# AVIF is the one export format whose encoder (aom) is a long build. The engine ships
# JPEG/TIFF16/PNG without it and says so at runtime (src/export/encoder.cpp).
find_package(libavif CONFIG QUIET)
find_package(Catch2 3 CONFIG REQUIRED)
find_package(Python3 REQUIRED COMPONENTS Interpreter Development.Embed)
find_package(pybind11 CONFIG REQUIRED)
include(cmake/onnxruntime.cmake)

include(CTest)

# Section 8 of PROMPT.md: throwaway probes that validate the engine stack on this
# machine before any real engine code exists. They graduate into src/ as they prove out.
add_subdirectory(probe)
add_subdirectory(src)
add_subdirectory(tests)
