#include "ops/sha256.h"

#include <array>
#include <fstream>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace latent {

namespace {

constexpr std::array<uint32_t, 64> kRoundConstants = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

uint32_t rotate_right(uint32_t value, uint32_t bits) {
  return (value >> bits) | (value << (32 - bits));
}

class Sha256 {
 public:
  void update(std::span<const uint8_t> data) {
    for (uint8_t byte : data) {
      block_[block_size_++] = byte;
      total_bits_ += 8;
      if (block_size_ == 64) compress();
    }
  }

  std::string finish() {
    const uint64_t length = total_bits_;
    update(std::span<const uint8_t>(&kPadStart, 1));
    static constexpr uint8_t kZero = 0;
    while (block_size_ != 56) {
      update(std::span<const uint8_t>(&kZero, 1));
    }
    std::array<uint8_t, 8> tail{};
    for (size_t i = 0; i < 8; ++i) {
      tail[i] = static_cast<uint8_t>(length >> (56 - 8 * i));
    }
    total_bits_ = length;
    for (uint8_t byte : tail) {
      block_[block_size_++] = byte;
      if (block_size_ == 64) compress();
    }
    return hex();
  }

 private:
  static constexpr uint8_t kPadStart = 0x80;

  void compress() {
    std::array<uint32_t, 64> words{};
    for (size_t i = 0; i < 16; ++i) {
      words[i] = static_cast<uint32_t>(block_[i * 4]) << 24 |
                 static_cast<uint32_t>(block_[i * 4 + 1]) << 16 |
                 static_cast<uint32_t>(block_[i * 4 + 2]) << 8 |
                 static_cast<uint32_t>(block_[i * 4 + 3]);
    }
    for (size_t i = 16; i < 64; ++i) {
      const uint32_t s0 =
          rotate_right(words[i - 15], 7) ^ rotate_right(words[i - 15], 18) ^ (words[i - 15] >> 3);
      const uint32_t s1 =
          rotate_right(words[i - 2], 17) ^ rotate_right(words[i - 2], 19) ^ (words[i - 2] >> 10);
      words[i] = words[i - 16] + s0 + words[i - 7] + s1;
    }
    std::array<uint32_t, 8> v = state_;
    for (size_t i = 0; i < 64; ++i) {
      const uint32_t s1 = rotate_right(v[4], 6) ^ rotate_right(v[4], 11) ^ rotate_right(v[4], 25);
      const uint32_t choice = (v[4] & v[5]) ^ (~v[4] & v[6]);
      const uint32_t temp1 = v[7] + s1 + choice + kRoundConstants[i] + words[i];
      const uint32_t s0 = rotate_right(v[0], 2) ^ rotate_right(v[0], 13) ^ rotate_right(v[0], 22);
      const uint32_t majority = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
      const uint32_t temp2 = s0 + majority;
      v = {temp1 + temp2, v[0], v[1], v[2], v[3] + temp1, v[4], v[5], v[6]};
    }
    for (size_t i = 0; i < 8; ++i) {
      state_[i] += v[i];
    }
    block_size_ = 0;
  }

  std::string hex() const {
    static constexpr std::string_view kDigits = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (uint32_t word : state_) {
      for (int shift = 28; shift >= 0; shift -= 4) {
        out.push_back(kDigits[(word >> shift) & 0xf]);
      }
    }
    return out;
  }

  std::array<uint32_t, 8> state_ = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::array<uint8_t, 64> block_{};
  size_t block_size_ = 0;
  uint64_t total_bits_ = 0;
};

}  // namespace

std::string sha256_hex(std::span<const uint8_t> data) {
  Sha256 hash;
  hash.update(data);
  return hash.finish();
}

std::string sha256_file_hex(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("cannot read " + path);
  Sha256 hash;
  std::vector<char> chunk(1 << 20);
  while (file) {
    file.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
    const auto read = static_cast<size_t>(file.gcount());
    if (read == 0) break;
    hash.update(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(chunk.data()), read));
  }
  return hash.finish();
}

}  // namespace latent
