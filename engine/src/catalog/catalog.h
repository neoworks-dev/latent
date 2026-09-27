// The catalog: SQLite, WAL, one connection guarded by a mutex because the import worker
// and the server thread both write it. Rowids are the PhotoIds the whole protocol uses,
// so they must stay stable across restarts — never delete and re-insert a path.
#pragma once

#include "raw/raw_metadata.h"

#include <cstdint>

#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

struct sqlite3;

namespace latent {

struct CatalogPhoto {
  int64_t id = 0;
  std::string path;
  std::string folder;
  std::string filename;
  uint32_t width = 0;
  uint32_t height = 0;
  std::string camera;
  std::string lens;
  std::string captured_at;
  std::string imported_at;
  std::string edited_at;
  int rating = 0;
  std::string flag = "none";
  bool has_sidecar = false;
  int iso = 0;
  std::string shutter;
  double aperture = 0;
  double focal_length = 0;
  std::string hash;

  // protocol/messages.schema.json#/definitions/CatalogPhoto.
  nlohmann::json to_json() const;
};

struct CatalogQuery {
  std::optional<std::string> folder;
  std::optional<int64_t> collection_id;
  std::optional<std::string> flag;
  std::optional<int> min_rating;
  // Exactly these rows, in the list's sort order. Empty means no id filter.
  std::vector<int64_t> photo_ids;
  // Case-insensitive substring of filename or camera. Empty matches everything.
  std::string query;
  std::string sort = "importedAt";
  bool descending = false;
  int limit = 0;  // 0 = every match
  int offset = 0;
};

struct CatalogPage {
  std::vector<CatalogPhoto> photos;
  int64_t total = 0;
};

struct CatalogFolder {
  std::string path;
  int64_t count = 0;
  // True when a watched root covers this folder, so photos dropped into it appear on their
  // own. False means the folder is only ever as fresh as its last rescan.
  bool watched = false;
};

// A folder Latent keeps a live watch on (catalog/watcher.h), remembered so the watch comes
// back with the daemon. Imported folders land here; imported single files do not, because
// picking three photos out of a folder is not asking for the rest of it.
struct WatchedFolder {
  std::string path;
  bool recursive = true;
};

struct CatalogCollection {
  int64_t id = 0;
  std::string name;
  int64_t count = 0;
};

// Every method is thread safe. Failures throw std::runtime_error carrying SQLite's message.
class Catalog {
 public:
  explicit Catalog(const std::string& path);
  ~Catalog();
  Catalog(const Catalog&) = delete;
  Catalog& operator=(const Catalog&) = delete;

  // $XDG_DATA_HOME/latent/catalog.db, or ~/.local/share/latent/catalog.db.
  static std::string default_path();

  const std::string& path() const { return path_; }

  // Inserts the file or refreshes its metadata, keeping rating, flag and imported_at.
  // Returns the stable rowid.
  int64_t register_photo(const std::string& path, const RawMetadata& metadata, bool has_sidecar);

  std::optional<CatalogPhoto> find_by_path(const std::string& path);
  std::optional<CatalogPhoto> get(int64_t photo_id);
  CatalogPage list(const CatalogQuery& query);
  std::vector<CatalogFolder> folders();

  // Remembers `path` as watched, widening an existing row to recursive but never narrowing
  // it. `unwatch_folder` is what a root that has left the disk gets at startup.
  void watch_folder(const std::string& path, bool recursive);
  void unwatch_folder(const std::string& path);
  std::vector<WatchedFolder> watched_folders();

  // Deletes rows and their collection memberships. Files on disk are never touched.
  // Returns how many rows actually went away.
  int remove_photos(const std::vector<int64_t>& photo_ids);

  bool set_rating(int64_t photo_id, int rating);
  bool set_flag(int64_t photo_id, const std::string& flag);
  void set_hash(int64_t photo_id, const std::string& hash);
  // Stamps edited_at with now; called on every non-transient stack change.
  void touch_edited(int64_t photo_id, bool has_sidecar);
  // The photo photo.open last opened, so the UI comes back on it after a restart. Nullopt
  // when none was, or when that row or its file is gone.
  void set_last_photo(int64_t photo_id);
  std::optional<CatalogPhoto> last_photo();

  std::vector<CatalogCollection> collections();
  int64_t create_collection(const std::string& name);
  void rename_collection(int64_t collection_id, const std::string& name);
  void delete_collection(int64_t collection_id);
  void add_to_collection(int64_t collection_id, const std::vector<int64_t>& photo_ids);
  void remove_from_collection(int64_t collection_id, const std::vector<int64_t>& photo_ids);

 private:
  void migrate();

  std::string path_;
  std::mutex mutex_;
  sqlite3* db_ = nullptr;
};

}  // namespace latent
