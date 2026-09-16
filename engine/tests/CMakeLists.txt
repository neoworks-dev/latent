add_executable(latent_tests catalog_test.cpp curve_test.cpp registry_test.cpp sidecar_test.cpp
  stack_test.cpp)
target_link_libraries(latent_tests PRIVATE latent_ops latent_catalog Catch2::Catch2WithMain)

# The render tests need a device, so they are their own binary: latent_tests still runs on
# a machine without an adapter.
add_executable(latent_render_tests render_test.cpp)
target_link_libraries(latent_render_tests PRIVATE latent_core Catch2::Catch2WithMain)

include(Catch)
catch_discover_tests(latent_tests)
catch_discover_tests(latent_render_tests)

# The smoke test drives the real binary over the real socket. It skips itself when the
# sample raw is missing, so a fresh clone still gets a green ctest.
find_program(BUN_EXECUTABLE bun)
if(BUN_EXECUTABLE)
  add_test(NAME smoke COMMAND ${BUN_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/smoke.ts)
  set_tests_properties(smoke PROPERTIES
    ENVIRONMENT "LATENTD=$<TARGET_FILE:latentd>"
    SKIP_RETURN_CODE 77
    TIMEOUT 180)
else()
  message(WARNING "bun not found; the end-to-end smoke test is not registered")
endif()
