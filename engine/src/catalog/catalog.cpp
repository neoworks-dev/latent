#include "catalog/catalog.h"

#include <cstdlib>
#include <ctime>

#include <algorithm>
#include <array>
#include <filesystem>
#include <stdexcept>

#include <sqlite3.h>

namespace latent {

namespace {

constexpr int kSchemaVersion = 3;

constexpr const char* kSchema = R"(
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  camera TEXT NOT NULL DEFAULT '',
  lens TEXT NOT NULL DEFAULT '',
  captured_at TEXT,
  imported_at TEXT NOT NULL,
  edited_at TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  flag TEXT NOT NULL DEFAULT 'none',
  has_sidecar INTEGER NOT NULL DEFAULT 0,
  iso INTEGER NOT NULL DEFAULT 0,
  shutter TEXT NOT NULL DEFAULT '',
  aperture REAL NOT NULL DEFAULT 0,
  focal_length REAL NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS collection_photos (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, photo_id)
);
CREATE TABLE IF NOT EXISTS watched_folders (
  path TEXT PRIMARY KEY,
  recursive INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
)";

// The `state` row holding the photo photo.open last opened.
constexpr const char* kLastPhotoKey = "lastPhotoId";

std::string now_iso8601() {
  const std::time_t when = std::time(nullptr);
  std::tm parts{};
  if (localtime_r(&when, &parts) == nullptr) return {};
  std::array<char, 32> buffer{};
  const size_t written = std::strftime(buffer.data(), buffer.size(), "%Y-%m-%dT%H:%M:%S", &parts);
  return std::string(buffer.data(), written);
}

// One prepared statement, finalised whatever happens. Binding is 1-based like the C API.
class Statement {
 public:
  Statement(sqlite3* db, const std::string& sql) : db_(db) {
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &handle_, nullptr) == SQLITE_OK) return;
    throw std::runtime_error("catalog: " + std::string(sqlite3_errmsg(db)) + " in: " + sql);
  }
  ~Statement() { sqlite3_finalize(handle_); }
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;

  void bind(int index, int64_t value) { sqlite3_bind_int64(handle_, index, value); }
  void bind(int index, double value) { sqlite3_bind_double(handle_, index, value); }
  void bind(int index, const std::string& value) {
    sqlite3_bind_text(handle_, index, value.c_str(), -1, SQLITE_TRANSIENT);
  }
  // Empty optional columns (captured_at, edited_at) must be NULL so sorting puts them last.
  void bind_or_null(int index, const std::string& value) {
    if (!value.empty()) {
      bind(index, value);
      return;
    }
    sqlite3_bind_null(handle_, index);
  }

  bool step() {
    const int status = sqlite3_step(handle_);
    if (status == SQLITE_ROW) return true;
    if (status == SQLITE_DONE) return false;
    throw std::runtime_error("catalog: " + std::string(sqlite3_errmsg(db_)));
  }
  void run() { step(); }
  // Required before a statement is bound and stepped a second time.
  void reset() {
    sqlite3_reset(handle_);
    sqlite3_clear_bindings(handle_);
  }

  int64_t integer(int column) const { return sqlite3_column_int64(handle_, column); }
  double real(int column) const { return sqlite3_column_double(handle_, column); }
  std::string text(int column) const {
    const auto* value = sqlite3_column_text(handle_, column);
    if (value == nullptr) return {};
    return std::string(reinterpret_cast<const char*>(value));
  }

 private:
  sqlite3* db_ = nullptr;
  sqlite3_stmt* handle_ = nullptr;
};

void execute(sqlite3* db, const char* sql) {
  char* message = nullptr;
  if (sqlite3_exec(db, sql, nullptr, nullptr, &message) == SQLITE_OK) return;
  const std::string text = message == nullptr ? "unknown error" : message;
  sqlite3_free(message);
  throw std::runtime_error("catalog: " + text);
}

constexpr const char* kPhotoColumns =
    "id, path, folder, filename, width, height, camera, lens, captured_at, imported_at, "
    "edited_at, rating, flag, has_sidecar, iso, shutter, aperture, focal_length, hash";

CatalogPhoto read_photo(const Statement& statement) {
  CatalogPhoto photo;
  photo.id = statement.integer(0);
  photo.path = statement.text(1);
  photo.folder = statement.text(2);
  photo.filename = statement.text(3);
  photo.width = static_cast<uint32_t>(statement.integer(4));
  photo.height = static_cast<uint32_t>(statement.integer(5));
  photo.camera = statement.text(6);
  photo.lens = statement.text(7);
  photo.captured_at = statement.text(8);
  photo.imported_at = statement.text(9);
  photo.edited_at = statement.text(10);
  photo.rating = static_cast<int>(statement.integer(11));
  photo.flag = statement.text(12);
  photo.has_sidecar = statement.integer(13) != 0;
  photo.iso = static_cast<int>(statement.integer(14));
  photo.shutter = statement.text(15);
  photo.aperture = statement.real(16);
  photo.focal_length = statement.real(17);
  photo.hash = statement.text(18);
  return photo;
}

std::string sort_column(const std::string& sort) {
  if (sort == "capturedAt") return "captured_at";
  if (sort == "filename") return "filename";
  if (sort == "rating") return "rating";
  if (sort == "editedAt") return "edited_at";
  return "imported_at";
}

// Returns " WHERE ..." plus the binder that fills it, so list() and its COUNT(*) twin
// cannot drift apart.
// Ids are integers straight from the caller's JSON, so inlining them cannot inject SQL and
// saves binding a variable number of parameters.
std::string id_list(const std::vector<int64_t>& ids) {
  std::string list;
  for (int64_t id : ids) {
    list += (list.empty() ? "" : ",") + std::to_string(id);
  }
  return list;
}

std::string where_clause(const CatalogQuery& query) {
  std::string clause = " WHERE 1=1";
  if (query.folder.has_value()) clause += " AND folder = :folder";
  if (query.flag.has_value()) clause += " AND flag = :flag";
  if (query.min_rating.has_value()) clause += " AND rating >= :minRating";
  if (!query.query.empty()) clause += " AND (filename LIKE :q OR camera LIKE :q2)";
  if (!query.photo_ids.empty()) clause += " AND id IN (" + id_list(query.photo_ids) + ")";
  if (query.collection_id.has_value()) {
    clause += " AND id IN (SELECT photo_id FROM collection_photos WHERE collection_id = :cid)";
  }
  return clause;
}

void bind_filters(Statement& statement, const CatalogQuery& query) {
  int index = 1;
  if (query.folder.has_value()) statement.bind(index++, *query.folder);
  if (query.flag.has_value()) statement.bind(index++, *query.flag);
  const std::optional<int64_t> rating = query.min_rating;
  if (rating.has_value()) statement.bind(index++, *rating);
  const std::string like = "%" + query.query + "%";
  if (!query.query.empty()) statement.bind(index++, like);
  if (!query.query.empty()) statement.bind(index++, like);
  if (query.collection_id.has_value()) statement.bind(index++, *query.collection_id);
}

}  // namespace

nlohmann::json CatalogPhoto::to_json() const {
  nlohmann::json value = {{"photoId", id},
                          {"path", path},
                          {"folder", folder},
                          {"filename", filename},
                          {"width", width},
                          {"height", height},
                          {"camera", camera},
                          {"rating", rating},
                          {"flag", flag},
                          {"hasSidecar", has_sidecar},
                          {"importedAt", imported_at}};
  if (!lens.empty()) value["lens"] = lens;
  if (!captured_at.empty()) value["capturedAt"] = captured_at;
  if (!edited_at.empty()) value["editedAt"] = edited_at;
  if (iso > 0) value["iso"] = iso;
  if (!shutter.empty()) value["shutter"] = shutter;
  if (aperture > 0) value["aperture"] = aperture;
  if (focal_length > 0) value["focalLength"] = focal_length;
  if (!hash.empty()) value["hash"] = hash;
  return value;
}

std::string Catalog::default_path() {
  const char* data_home = std::getenv("XDG_DATA_HOME");
  if (data_home != nullptr && data_home[0] != '\0') {
    return (std::filesystem::path(data_home) / "latent" / "catalog.db").string();
  }
  const char* home = std::getenv("HOME");
  const std::filesystem::path base = home == nullptr ? std::filesystem::current_path() : home;
  return (base / ".local" / "share" / "latent" / "catalog.db").string();
}

Catalog::Catalog(const std::string& path) : path_(path) {
  const std::filesystem::path parent = std::filesystem::path(path).parent_path();
  if (!parent.empty()) std::filesystem::create_directories(parent);
  const int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
  if (sqlite3_open_v2(path.c_str(), &db_, flags, nullptr) != SQLITE_OK) {
    const std::string message = db_ == nullptr ? "out of memory" : sqlite3_errmsg(db_);
    sqlite3_close(db_);
    throw std::runtime_error("catalog: cannot open " + path + ": " + message);
  }
  execute(db_, "PRAGMA journal_mode=WAL");
  execute(db_, "PRAGMA foreign_keys=ON");
  execute(db_, "PRAGMA busy_timeout=5000");
  migrate();
}

Catalog::~Catalog() {
  sqlite3_close(db_);
}

void Catalog::migrate() {
  Statement version(db_, "PRAGMA user_version");
  version.step();
  const int64_t current = version.integer(0);
  if (current > kSchemaVersion) {
    throw std::runtime_error("catalog: schema version " + std::to_string(current) +
                             " is newer than this engine");
  }
  execute(db_, kSchema);
  // Before version 3 the folder scan walked into `<photo>.latent.d/` and imported the mask
  // rasters, depth maps and generative patches there as photos (ops/mask.h).
  if (current < 3) execute(db_, "DELETE FROM photos WHERE path GLOB '*.latent.d/*'");
  execute(db_, ("PRAGMA user_version=" + std::to_string(kSchemaVersion)).c_str());
}

int64_t Catalog::register_photo(const std::string& path, const RawMetadata& metadata,
                                bool has_sidecar) {
  const std::filesystem::path file(path);
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement insert(db_,
                   "INSERT INTO photos (path, folder, filename, width, height, camera, lens, "
                   "captured_at, imported_at, iso, shutter, aperture, focal_length, has_sidecar) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
                   "width=excluded.width, height=excluded.height, camera=excluded.camera, "
                   "lens=excluded.lens, captured_at=excluded.captured_at, iso=excluded.iso, "
                   "shutter=excluded.shutter, aperture=excluded.aperture, "
                   "focal_length=excluded.focal_length, has_sidecar=excluded.has_sidecar");
  insert.bind(1, path);
  insert.bind(2, file.parent_path().string());
  insert.bind(3, file.filename().string());
  insert.bind(4, static_cast<int64_t>(metadata.width));
  insert.bind(5, static_cast<int64_t>(metadata.height));
  insert.bind(6, metadata.camera);
  insert.bind(7, metadata.lens);
  insert.bind_or_null(8, metadata.captured_at);
  insert.bind(9, now_iso8601());
  insert.bind(10, static_cast<int64_t>(metadata.iso));
  insert.bind(11, metadata.shutter);
  insert.bind(12, metadata.aperture);
  insert.bind(13, metadata.focal_length);
  insert.bind(14, static_cast<int64_t>(has_sidecar ? 1 : 0));
  insert.run();

  Statement lookup(db_, "SELECT id FROM photos WHERE path = ?");
  lookup.bind(1, path);
  if (!lookup.step()) throw std::runtime_error("catalog: insert did not stick for " + path);
  return lookup.integer(0);
}

std::optional<CatalogPhoto> Catalog::find_by_path(const std::string& path) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement select(db_, std::string("SELECT ") + kPhotoColumns + " FROM photos WHERE path = ?");
  select.bind(1, path);
  if (!select.step()) return std::nullopt;
  return read_photo(select);
}

std::optional<CatalogPhoto> Catalog::get(int64_t photo_id) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement select(db_, std::string("SELECT ") + kPhotoColumns + " FROM photos WHERE id = ?");
  select.bind(1, photo_id);
  if (!select.step()) return std::nullopt;
  return read_photo(select);
}

CatalogPage Catalog::list(const CatalogQuery& query) {
  const std::lock_guard<std::mutex> lock(mutex_);
  const std::string filters = where_clause(query);
  CatalogPage page;
  Statement counter(db_, "SELECT COUNT(*) FROM photos" + filters);
  bind_filters(counter, query);
  counter.step();
  page.total = counter.integer(0);

  std::string sql = std::string("SELECT ") + kPhotoColumns + " FROM photos" + filters +
                    " ORDER BY " + sort_column(query.sort) + (query.descending ? " DESC" : " ASC") +
                    // The tie-breaker is part of the protocol: paging must not reshuffle.
                    ", filename ASC, id ASC";
  if (query.limit > 0) sql += " LIMIT " + std::to_string(query.limit);
  if (query.offset > 0) {
    sql += (query.limit > 0 ? "" : " LIMIT -1");
    sql += " OFFSET " + std::to_string(query.offset);
  }
  Statement select(db_, sql);
  bind_filters(select, query);
  while (select.step()) {
    page.photos.push_back(read_photo(select));
  }
  return page;
}

std::vector<CatalogFolder> Catalog::folders() {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement roots(db_, "SELECT path, recursive FROM watched_folders");
  std::vector<WatchedFolder> watched;
  while (roots.step()) {
    watched.push_back({roots.text(0), roots.integer(1) != 0});
  }

  Statement select(db_, "SELECT folder, COUNT(*) FROM photos GROUP BY folder ORDER BY folder");
  std::vector<CatalogFolder> out;
  while (select.step()) {
    CatalogFolder folder{select.text(0), select.integer(1), false};
    folder.watched = std::any_of(watched.begin(), watched.end(), [&folder](const WatchedFolder& r) {
      if (folder.path == r.path) return true;
      return r.recursive && folder.path.starts_with(r.path + "/");
    });
    out.push_back(std::move(folder));
  }
  return out;
}

void Catalog::watch_folder(const std::string& path, bool recursive) {
  const std::lock_guard<std::mutex> lock(mutex_);
  // A folder imported recursively once stays recursive: the narrower import did not ask
  // for the subtree to stop being watched.
  Statement insert(db_,
                   "INSERT INTO watched_folders (path, recursive) VALUES (?,?) "
                   "ON CONFLICT(path) DO UPDATE SET "
                   "recursive = MAX(excluded.recursive, watched_folders.recursive)");
  insert.bind(1, path);
  insert.bind(2, static_cast<int64_t>(recursive ? 1 : 0));
  insert.run();
}

void Catalog::unwatch_folder(const std::string& path) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement remove(db_, "DELETE FROM watched_folders WHERE path = ?");
  remove.bind(1, path);
  remove.run();
}

std::vector<WatchedFolder> Catalog::watched_folders() {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement select(db_, "SELECT path, recursive FROM watched_folders ORDER BY path");
  std::vector<WatchedFolder> out;
  while (select.step()) {
    out.push_back({select.text(0), select.integer(1) != 0});
  }
  return out;
}

int Catalog::remove_photos(const std::vector<int64_t>& photo_ids) {
  if (photo_ids.empty()) return 0;
  const std::lock_guard<std::mutex> lock(mutex_);
  // ON DELETE CASCADE on collection_photos takes the memberships with the row.
  Statement remove(db_, "DELETE FROM photos WHERE id IN (" + id_list(photo_ids) + ")");
  remove.run();
  return sqlite3_changes(db_);
}

bool Catalog::set_rating(int64_t photo_id, int rating) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE photos SET rating = ? WHERE id = ?");
  update.bind(1, static_cast<int64_t>(rating));
  update.bind(2, photo_id);
  update.run();
  return sqlite3_changes(db_) > 0;
}

bool Catalog::set_flag(int64_t photo_id, const std::string& flag) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE photos SET flag = ? WHERE id = ?");
  update.bind(1, flag);
  update.bind(2, photo_id);
  update.run();
  return sqlite3_changes(db_) > 0;
}

void Catalog::set_hash(int64_t photo_id, const std::string& hash) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE photos SET hash = ? WHERE id = ?");
  update.bind(1, hash);
  update.bind(2, photo_id);
  update.run();
}

void Catalog::touch_edited(int64_t photo_id, bool has_sidecar) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE photos SET edited_at = ?, has_sidecar = ? WHERE id = ?");
  update.bind(1, now_iso8601());
  update.bind(2, static_cast<int64_t>(has_sidecar ? 1 : 0));
  update.bind(3, photo_id);
  update.run();
}

void Catalog::set_last_photo(int64_t photo_id) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement upsert(db_, "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)");
  upsert.bind(1, std::string(kLastPhotoKey));
  upsert.bind(2, std::to_string(photo_id));
  upsert.run();
}

std::optional<CatalogPhoto> Catalog::last_photo() {
  int64_t photo_id = 0;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    Statement select(db_, "SELECT value FROM state WHERE key = ?");
    select.bind(1, std::string(kLastPhotoKey));
    if (!select.step()) return std::nullopt;
    photo_id = std::strtoll(select.text(0).c_str(), nullptr, 10);
  }
  // A row removed since — or a file gone from the disk — is no photo to come back to.
  std::optional<CatalogPhoto> photo = get(photo_id);
  if (!photo.has_value() || !std::filesystem::exists(photo->path)) return std::nullopt;
  return photo;
}

std::vector<CatalogCollection> Catalog::collections() {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement select(db_,
                   "SELECT c.id, c.name, COUNT(cp.photo_id) FROM collections c "
                   "LEFT JOIN collection_photos cp ON cp.collection_id = c.id "
                   "GROUP BY c.id ORDER BY c.name");
  std::vector<CatalogCollection> out;
  while (select.step()) {
    out.push_back({select.integer(0), select.text(1), select.integer(2)});
  }
  return out;
}

int64_t Catalog::create_collection(const std::string& name) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement insert(db_, "INSERT INTO collections (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  insert.bind(1, name);
  insert.run();
  Statement lookup(db_, "SELECT id FROM collections WHERE name = ?");
  lookup.bind(1, name);
  if (!lookup.step()) throw std::runtime_error("catalog: collection '" + name + "' not created");
  return lookup.integer(0);
}

void Catalog::rename_collection(int64_t collection_id, const std::string& name) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE collections SET name = ? WHERE id = ?");
  update.bind(1, name);
  update.bind(2, collection_id);
  update.run();
}

void Catalog::delete_collection(int64_t collection_id) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement remove(db_, "DELETE FROM collections WHERE id = ?");
  remove.bind(1, collection_id);
  remove.run();
}

void Catalog::add_to_collection(int64_t collection_id, const std::vector<int64_t>& photo_ids) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement insert(db_,
                   "INSERT INTO collection_photos (collection_id, photo_id) VALUES (?, ?) "
                   "ON CONFLICT DO NOTHING");
  for (int64_t photo_id : photo_ids) {
    insert.reset();
    insert.bind(1, collection_id);
    insert.bind(2, photo_id);
    insert.run();
  }
}

void Catalog::remove_from_collection(int64_t collection_id, const std::vector<int64_t>& photo_ids) {
  const std::lock_guard<std::mutex> lock(mutex_);
  Statement remove(db_, "DELETE FROM collection_photos WHERE collection_id = ? AND photo_id = ?");
  for (int64_t photo_id : photo_ids) {
    remove.reset();
    remove.bind(1, collection_id);
    remove.bind(2, photo_id);
    remove.run();
  }
}

}  // namespace latent
