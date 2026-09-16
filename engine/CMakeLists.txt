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
find_package(PNG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(unofficial-uwebsockets CONFIG REQUIRED)
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
