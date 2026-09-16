add_executable(latent_tests registry_test.cpp sidecar_test.cpp stack_test.cpp)
target_link_libraries(latent_tests PRIVATE latent_ops Catch2::Catch2WithMain)

include(Catch)
catch_discover_tests(latent_tests)

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
