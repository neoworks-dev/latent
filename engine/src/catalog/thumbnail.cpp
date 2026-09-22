#include "catalog/thumbnail.h"

#include "image/import_image.h"
#include "image/jpeg.h"

#include <cstdlib>

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace latent {

namespace {

constexpr int kThumbnailQuality = 85;

std::filesystem::path cache_root() {
  const char* cache_home = std::getenv("XDG_CACHE_HOME");
  if (cache_home != nullptr && cache_home[0] != '\0') {
    return std::filesystem::path(cache_home) / "latent" / "thumbs";
  }
  const char* home = std::getenv("HOME");
  const std::filesystem::path base = home == nullptr ? std::filesystem::current_path() : home;
  return base / ".cache" / "latent" / "thumbs";
}

}  // namespace

std::string thumbnail_cache_path(const std::string& key, uint32_t size) {
  return (cache_root() / (key + "-" + std::to_string(size) + ".jpg")).string();
}

std::optional<Thumbnail> read_cached_thumbnail(const std::string& cache_path) {
  std::ifstream file(cache_path, std::ios::binary | std::ios::ate);
  if (!file) return std::nullopt;
  const std::streamsize size = file.tellg();
  if (size <= 0) return std::nullopt;
  Thumbnail thumbnail;
  thumbnail.jpeg.resize(static_cast<size_t>(size));
  file.seekg(0);
  file.read(reinterpret_cast<char*>(thumbnail.jpeg.data()), size);
  if (!file) return std::nullopt;
  const ImageSize dimensions = jpeg_dimensions(thumbnail.jpeg);
  thumbnail.width = dimensions.width;
  thumbnail.height = dimensions.height;
  return thumbnail;
}

void forget_thumbnails(const std::string& key) {
  std::error_code error;
  if (!std::filesystem::is_directory(cache_root(), error)) return;
  for (const auto& entry : std::filesystem::directory_iterator(cache_root(), error)) {
    const std::string name = entry.path().filename().string();
    if (!name.starts_with(key + "-")) continue;
    std::filesystem::remove(entry.path(), error);
  }
}

Thumbnail make_thumbnail(const std::string& photo_path, const std::string& cache_path,
                         uint32_t size) {
  const Rgb8Image image = load_photo_preview(photo_path, size);
  Thumbnail thumbnail;
  thumbnail.width = image.width;
  thumbnail.height = image.height;
  thumbnail.jpeg = encode_jpeg(image, kThumbnailQuality);

  std::error_code error;
  std::filesystem::create_directories(std::filesystem::path(cache_path).parent_path(), error);
  const std::string temporary = cache_path + ".tmp";
  std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
  if (!file) return thumbnail;  // an unwritable cache is not worth failing the request for
  file.write(reinterpret_cast<const char*>(thumbnail.jpeg.data()),
             static_cast<std::streamsize>(thumbnail.jpeg.size()));
  file.close();
  std::filesystem::rename(temporary, cache_path, error);
  return thumbnail;
}

}  // namespace latent
