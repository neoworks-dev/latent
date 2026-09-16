# `cmake --build --preset dev --target format` rewrites every engine source in place.
# `--target format-check` fails when any file would change; CI and the pre-commit
# hook use that. third_party/ and build/ are never touched.

find_program(CLANG_FORMAT_EXECUTABLE clang-format)
if(NOT CLANG_FORMAT_EXECUTABLE)
  message(WARNING "clang-format not found; format targets unavailable")
  return()
endif()

file(GLOB_RECURSE ENGINE_FORMAT_SOURCES
  CONFIGURE_DEPENDS
  "${CMAKE_SOURCE_DIR}/src/*.cpp" "${CMAKE_SOURCE_DIR}/src/*.h"
  "${CMAKE_SOURCE_DIR}/probe/*.cpp" "${CMAKE_SOURCE_DIR}/probe/*.h"
  "${CMAKE_SOURCE_DIR}/tests/*.cpp" "${CMAKE_SOURCE_DIR}/tests/*.h")

add_custom_target(format
  COMMAND ${CLANG_FORMAT_EXECUTABLE} -i ${ENGINE_FORMAT_SOURCES}
  COMMENT "clang-format: rewriting engine sources"
  VERBATIM)

add_custom_target(format-check
  COMMAND ${CLANG_FORMAT_EXECUTABLE} --dry-run --Werror ${ENGINE_FORMAT_SOURCES}
  COMMENT "clang-format: checking engine sources"
  VERBATIM)
