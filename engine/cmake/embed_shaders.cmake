# WGSL is compiled into the binary; latentd never reads a shader from the working
# directory. `latent_embed_shaders(<target> <wgsl>...)` generates a header of raw string
# literals and puts its directory on the target's include path.

function(latent_embed_shaders target)
  set(sources "")
  foreach(shader IN LISTS ARGN)
    get_filename_component(absolute "${shader}" ABSOLUTE)
    list(APPEND sources "${absolute}")
  endforeach()

  set(output "${CMAKE_BINARY_DIR}/generated/latent_shaders.h")
  add_custom_command(
    OUTPUT "${output}"
    COMMAND ${CMAKE_COMMAND} -DOUTPUT=${output} "-DSOURCES=${sources}" -P
            "${CMAKE_SOURCE_DIR}/cmake/embed_shaders_run.cmake"
    DEPENDS ${sources} "${CMAKE_SOURCE_DIR}/cmake/embed_shaders_run.cmake"
    COMMENT "embedding WGSL shaders"
    VERBATIM)

  add_custom_target(${target}_shaders DEPENDS "${output}")
  add_dependencies(${target} ${target}_shaders)
  target_sources(${target} PRIVATE "${output}")
  target_include_directories(${target} PUBLIC "${CMAKE_BINARY_DIR}/generated")
endfunction()
