# Generates one header of raw string literals from engine/shaders/*.wgsl.
# Invoked by embed_shaders.cmake as `cmake -DOUTPUT=... -DSOURCES=... -P`.

set(generated "// GENERATED from engine/shaders/*.wgsl by cmake/embed_shaders_run.cmake. Do not edit.\n")
string(APPEND generated "#pragma once\n\n#include <string_view>\n\nnamespace latent::shaders {\n\n")

foreach(source IN LISTS SOURCES)
  get_filename_component(stem "${source}" NAME_WE)
  string(REPLACE "_" ";" words "${stem}")
  set(symbol "")
  foreach(word IN LISTS words)
    string(SUBSTRING "${word}" 0 1 head)
    string(SUBSTRING "${word}" 1 -1 tail)
    string(TOUPPER "${head}" head)
    string(APPEND symbol "${head}${tail}")
  endforeach()
  file(READ "${source}" code)
  string(FIND "${code}" ")WGSL\"" clash)
  if(NOT clash EQUAL -1)
    message(FATAL_ERROR "${source} contains the raw string delimiter )WGSL\"")
  endif()
  string(APPEND generated "inline constexpr std::string_view k${symbol} = R\"WGSL(\n${code})WGSL\";\n\n")
endforeach()

string(APPEND generated "}  // namespace latent::shaders\n")

set(previous "")
if(EXISTS "${OUTPUT}")
  file(READ "${OUTPUT}" previous)
endif()
if(NOT previous STREQUAL generated)
  file(WRITE "${OUTPUT}" "${generated}")
endif()
