#include "image/jpeg.h"

#include <cstddef>
#include <cstdint>

#include <utility>

#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

// A 2x3 image whose every pixel is its own label: the red channel is the column, the green
// channel the row, so a rotation is checked by reading coordinates back out of the pixels.
//
//   (0,0) (1,0)
//   (0,1) (1,1)
//   (0,2) (1,2)
Rgb8Image labelled_2x3() {
  Rgb8Image image;
  image.width = 2;
  image.height = 3;
  image.pixels.resize(2 * 3 * 3);
  for (uint32_t y = 0; y < image.height; ++y) {
    for (uint32_t x = 0; x < image.width; ++x) {
      const size_t at = (static_cast<size_t>(y) * image.width + x) * 3;
      image.pixels[at] = static_cast<uint8_t>(x);
      image.pixels[at + 1] = static_cast<uint8_t>(y);
      image.pixels[at + 2] = 7;
    }
  }
  return image;
}

// The source coordinate the pixel at (x, y) of `image` was labelled with.
std::pair<uint8_t, uint8_t> label_at(const Rgb8Image& image, uint32_t x, uint32_t y) {
  const size_t at = (static_cast<size_t>(y) * image.width + x) * 3;
  REQUIRE(image.pixels[at + 2] == 7);
  return {image.pixels[at], image.pixels[at + 1]};
}

}  // namespace

TEST_CASE("rotate_for_flip leaves an unflipped image alone", "[image]") {
  const Rgb8Image source = labelled_2x3();
  const Rgb8Image out = rotate_for_flip(source, 0);
  REQUIRE(out.width == 2);
  REQUIRE(out.height == 3);
  REQUIRE(out.pixels == source.pixels);
}

TEST_CASE("rotate_for_flip 3 turns an image 180 degrees", "[image]") {
  const Rgb8Image out = rotate_for_flip(labelled_2x3(), 3);
  REQUIRE(out.width == 2);
  REQUIRE(out.height == 3);
  // Bottom-right of the source becomes top-left.
  REQUIRE(label_at(out, 0, 0) == std::pair<uint8_t, uint8_t>{1, 2});
  REQUIRE(label_at(out, 1, 0) == std::pair<uint8_t, uint8_t>{0, 2});
  REQUIRE(label_at(out, 0, 2) == std::pair<uint8_t, uint8_t>{1, 0});
  REQUIRE(label_at(out, 1, 2) == std::pair<uint8_t, uint8_t>{0, 0});
}

TEST_CASE("rotate_for_flip 5 turns an image 90 degrees counter-clockwise", "[image]") {
  const Rgb8Image out = rotate_for_flip(labelled_2x3(), 5);
  REQUIRE(out.width == 3);
  REQUIRE(out.height == 2);
  // The source's right column becomes the top row, left to right.
  REQUIRE(label_at(out, 0, 0) == std::pair<uint8_t, uint8_t>{1, 0});
  REQUIRE(label_at(out, 1, 0) == std::pair<uint8_t, uint8_t>{1, 1});
  REQUIRE(label_at(out, 2, 0) == std::pair<uint8_t, uint8_t>{1, 2});
  REQUIRE(label_at(out, 0, 1) == std::pair<uint8_t, uint8_t>{0, 0});
  REQUIRE(label_at(out, 2, 1) == std::pair<uint8_t, uint8_t>{0, 2});
}

TEST_CASE("rotate_for_flip 6 turns an image 90 degrees clockwise", "[image]") {
  const Rgb8Image out = rotate_for_flip(labelled_2x3(), 6);
  REQUIRE(out.width == 3);
  REQUIRE(out.height == 2);
  // The source's left column becomes the top row, bottom to top.
  REQUIRE(label_at(out, 0, 0) == std::pair<uint8_t, uint8_t>{0, 2});
  REQUIRE(label_at(out, 1, 0) == std::pair<uint8_t, uint8_t>{0, 1});
  REQUIRE(label_at(out, 2, 0) == std::pair<uint8_t, uint8_t>{0, 0});
  REQUIRE(label_at(out, 0, 1) == std::pair<uint8_t, uint8_t>{1, 2});
  REQUIRE(label_at(out, 2, 1) == std::pair<uint8_t, uint8_t>{1, 0});
}

TEST_CASE("two 90 degree turns the opposite way are the identity", "[image]") {
  const Rgb8Image source = labelled_2x3();
  const Rgb8Image round_trip = rotate_for_flip(rotate_for_flip(source, 6), 5);
  REQUIRE(round_trip.width == source.width);
  REQUIRE(round_trip.height == source.height);
  REQUIRE(round_trip.pixels == source.pixels);
}
