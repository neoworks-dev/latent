// Times Florence-2 open-vocabulary detection on one JPEG, stage by stage, outside the
// daemon. `probe_florence <store>/florence-2-base <image.jpg> "<phrase>"`.
#include "ai/florence2.h"
#include "image/jpeg.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>

#include <fstream>
#include <iterator>
#include <thread>
#include <vector>

int main(int argc, char** argv) {
  if (argc < 4) {
    std::fprintf(stderr, "usage: probe_florence <model-dir> <image.jpg> <phrase>\n");
    return 2;
  }
  using clock = std::chrono::steady_clock;
  const auto started = clock::now();
  latent::Florence2 model(argv[1]);
  const auto loaded = clock::now();
  std::ifstream file(argv[2], std::ios::binary);
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                                   std::istreambuf_iterator<char>());
  latent::Rgb8Image image = latent::decode_jpeg(bytes);
  // Optional fourth argument: long edge to box-resize to before detecting.
  if (argc > 4) image = latent::box_resize_to_fit(image, static_cast<uint32_t>(std::atoi(argv[4])));
  std::printf("image %ux%u, load %.0f ms\n", image.width, image.height,
              std::chrono::duration<double, std::milli>(loaded - started).count());
  const auto before = clock::now();
  // Optional fifth argument "thread": detect on a std::thread, as the daemon's worker does.
  std::optional<latent::DetectionBox> box;
  if (argc > 5) {
    std::thread([&] { box = model.detect(image, argv[3]); }).join();
  } else {
    box = model.detect(image, argv[3]);
  }
  const auto after = clock::now();
  std::printf("detect %.0f ms: ",
              std::chrono::duration<double, std::milli>(after - before).count());
  if (!box) {
    std::printf("no box\n");
    return 1;
  }
  std::printf("box %.0f %.0f %.0f %.0f\n", (*box)[0], (*box)[1], (*box)[2], (*box)[3]);
  return 0;
}
