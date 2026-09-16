// SHA-256 for sidecar source hashes. Hand-rolled (FIPS 180-4) rather than pulling
// OpenSSL into the engine for one 64-line function.
#pragma once

#include <cstddef>
#include <cstdint>

#include <span>
#include <string>

namespace latent {

std::string sha256_hex(std::span<const uint8_t> data);

// Streams the file in chunks. Throws std::runtime_error if it cannot be read.
std::string sha256_file_hex(const std::string& path);

}  // namespace latent
