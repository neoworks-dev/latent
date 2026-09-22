#include "catalog/catalog.h"

#include <unistd.h>

#include <filesystem>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <sqlite3.h>

using namespace latent;

namespace {

// Every test gets its own database under /tmp; the real catalog is never opened here.
class TemporaryCatalog {
 public:
  TemporaryCatalog()
      : path_(
            (std::filesystem::temp_directory_path() / ("latent-test-" + std::to_string(::getpid()) +
                                                       "-" + std::to_string(++counter_) + ".db"))
                .string()),
        catalog_(path_) {}
  ~TemporaryCatalog() {
    std::error_code error;
    for (const char* suffix : {"", "-wal", "-shm"}) {
      std::filesystem::remove(path_ + suffix, error);
    }
  }
  TemporaryCatalog(const TemporaryCatalog&) = delete;
  TemporaryCatalog& operator=(const TemporaryCatalog&) = delete;

  Catalog& operator*() { return catalog_; }
  Catalog* operator->() { return &catalog_; }
  const std::string& path() const { return path_; }

 private:
  static int counter_;
  std::string path_;
  Catalog catalog_;
};

int TemporaryCatalog::counter_ = 0;

RawMetadata sample(const std::string& camera, int iso) {
  RawMetadata metadata;
  metadata.width = 6000;
  metadata.height = 4000;
  metadata.camera = camera;
  metadata.lens = "E 35mm F1.8";
  metadata.captured_at = "2026-09-01T12:00:00";
  metadata.iso = iso;
  metadata.shutter = "1/250";
  metadata.aperture = 2.8;
  metadata.focal_length = 35;
  return metadata;
}

}  // namespace

TEST_CASE("registering a photo returns a stable id and keeps user data") {
  TemporaryCatalog catalog;
  const int64_t id = catalog->register_photo("/photos/a.arw", sample("Sony A6400", 100), false);
  REQUIRE(id >= 1);
  REQUIRE(catalog->set_rating(id, 4));
  REQUIRE(catalog->set_flag(id, "pick"));

  // A re-import refreshes metadata but must not reset the rating or move the id.
  REQUIRE(catalog->register_photo("/photos/a.arw", sample("Sony A6400", 800), true) == id);
  const CatalogPhoto row = *catalog->get(id);
  REQUIRE(row.iso == 800);
  REQUIRE(row.rating == 4);
  REQUIRE(row.flag == "pick");
  REQUIRE(row.has_sidecar);
  REQUIRE(row.folder == "/photos");
  REQUIRE(row.filename == "a.arw");
  REQUIRE(row.to_json()["photoId"] == id);
  REQUIRE(row.to_json()["focalLength"] == 35.0);
}

TEST_CASE("ids survive closing and reopening the database") {
  TemporaryCatalog catalog;
  const int64_t id = catalog->register_photo("/photos/b.nef", sample("Nikon Z6", 200), false);
  Catalog reopened(catalog.path());
  REQUIRE(reopened.find_by_path("/photos/b.nef")->id == id);
  REQUIRE(!reopened.find_by_path("/photos/missing.nef").has_value());
}

TEST_CASE("list filters, sorts and pages") {
  TemporaryCatalog catalog;
  const int64_t first = catalog->register_photo("/a/1.arw", sample("Sony", 100), false);
  const int64_t second = catalog->register_photo("/a/2.arw", sample("Sony", 200), false);
  const int64_t third = catalog->register_photo("/b/3.arw", sample("Sony", 400), false);
  catalog->set_rating(first, 5);
  catalog->set_rating(second, 3);
  catalog->set_flag(third, "reject");

  CatalogQuery query;
  REQUIRE(catalog->list(query).total == 3);

  query.folder = "/a";
  const CatalogPage folder_page = catalog->list(query);
  REQUIRE(folder_page.total == 2);
  REQUIRE(folder_page.photos.size() == 2);

  query = {};
  query.min_rating = 4;
  REQUIRE(catalog->list(query).total == 1);

  query = {};
  query.flag = "reject";
  REQUIRE(catalog->list(query).photos.at(0).id == third);

  query = {};
  query.sort = "filename";
  query.descending = true;
  REQUIRE(catalog->list(query).photos.at(0).filename == "3.arw");

  query = {};
  query.sort = "filename";
  query.limit = 1;
  query.offset = 1;
  const CatalogPage page = catalog->list(query);
  REQUIRE(page.total == 3);
  REQUIRE(page.photos.size() == 1);
  REQUIRE(page.photos.at(0).filename == "2.arw");
}

TEST_CASE("list matches ids and a text query") {
  TemporaryCatalog catalog;
  const int64_t first = catalog->register_photo("/a/beach.arw", sample("Sony A6400", 100), false);
  const int64_t second = catalog->register_photo("/a/forest.nef", sample("Nikon Z6", 100), false);

  CatalogQuery query;
  query.photo_ids = {second};
  REQUIRE(catalog->list(query).photos.at(0).id == second);

  query = {};
  query.query = "BEA";  // case-insensitive substring of the filename
  REQUIRE(catalog->list(query).photos.at(0).id == first);

  query = {};
  query.query = "nikon";  // and of the camera
  REQUIRE(catalog->list(query).photos.at(0).id == second);

  query = {};
  query.query = "nothing here";
  REQUIRE(catalog->list(query).total == 0);
}

TEST_CASE("removing rows takes their collection memberships with them") {
  TemporaryCatalog catalog;
  const int64_t first = catalog->register_photo("/a/1.arw", sample("Sony", 100), false);
  const int64_t second = catalog->register_photo("/a/2.arw", sample("Sony", 100), false);
  const int64_t collection = catalog->create_collection("Keepers");
  catalog->add_to_collection(collection, {first, second});

  REQUIRE(catalog->remove_photos({first, 4242}) == 1);
  REQUIRE(!catalog->get(first).has_value());
  REQUIRE(catalog->get(second).has_value());
  REQUIRE(catalog->collections().at(0).count == 1);
  REQUIRE(catalog->remove_photos({}) == 0);

  // Re-importing the same path is a new row, as the protocol says.
  REQUIRE(catalog->register_photo("/a/1.arw", sample("Sony", 100), false) != first);
}

TEST_CASE("folders report one row per directory with counts") {
  TemporaryCatalog catalog;
  catalog->register_photo("/a/1.arw", sample("Sony", 100), false);
  catalog->register_photo("/a/2.arw", sample("Sony", 100), false);
  catalog->register_photo("/b/3.arw", sample("Sony", 100), false);
  const std::vector<CatalogFolder> folders = catalog->folders();
  REQUIRE(folders.size() == 2);
  REQUIRE(folders.at(0).path == "/a");
  REQUIRE(folders.at(0).count == 2);
  REQUIRE(folders.at(1).count == 1);
}

TEST_CASE("collections hold members and report their size") {
  TemporaryCatalog catalog;
  const int64_t first = catalog->register_photo("/a/1.arw", sample("Sony", 100), false);
  const int64_t second = catalog->register_photo("/a/2.arw", sample("Sony", 100), false);
  const int64_t id = catalog->create_collection("Keepers");
  REQUIRE(catalog->create_collection("Keepers") == id);  // creating twice is idempotent

  catalog->add_to_collection(id, {first, second});
  catalog->add_to_collection(id, {first});  // a duplicate member is not an error
  REQUIRE(catalog->collections().at(0).count == 2);

  CatalogQuery query;
  query.collection_id = id;
  REQUIRE(catalog->list(query).total == 2);

  catalog->remove_from_collection(id, {second});
  REQUIRE(catalog->collections().at(0).count == 1);

  catalog->rename_collection(id, "Portfolio");
  REQUIRE(catalog->collections().at(0).name == "Portfolio");

  catalog->delete_collection(id);
  REQUIRE(catalog->collections().empty());
  // Deleting a collection must not delete its photos.
  REQUIRE(catalog->get(first).has_value());
}

TEST_CASE("edits stamp edited_at and the sidecar flag") {
  TemporaryCatalog catalog;
  const int64_t id = catalog->register_photo("/a/1.arw", sample("Sony", 100), false);
  REQUIRE(catalog->get(id)->edited_at.empty());
  REQUIRE(catalog->get(id)->to_json().contains("editedAt") == false);

  catalog->touch_edited(id, true);
  const CatalogPhoto row = *catalog->get(id);
  REQUIRE(!row.edited_at.empty());
  REQUIRE(row.has_sidecar);

  catalog->set_hash(id, "deadbeef");
  REQUIRE(catalog->get(id)->hash == "deadbeef");
}

TEST_CASE("an unknown photo id is reported, not invented") {
  TemporaryCatalog catalog;
  REQUIRE(!catalog->get(4242).has_value());
  REQUIRE(!catalog->set_rating(4242, 3));
  REQUIRE(!catalog->set_flag(4242, "pick"));
}

TEST_CASE("watched roots survive a reopen and widen but never narrow") {
  TemporaryCatalog catalog;
  catalog->watch_folder("/photos/trip", false);
  REQUIRE(catalog->watched_folders().size() == 1);
  REQUIRE(catalog->watched_folders().at(0).recursive == false);

  // Importing the same folder recursively widens the watch; importing it flat again
  // afterwards must not take the subtree back off.
  catalog->watch_folder("/photos/trip", true);
  catalog->watch_folder("/photos/trip", false);
  REQUIRE(catalog->watched_folders().at(0).recursive);

  Catalog reopened(catalog.path());
  REQUIRE(reopened.watched_folders().at(0).path == "/photos/trip");
  reopened.unwatch_folder("/photos/trip");
  REQUIRE(reopened.watched_folders().empty());
}

TEST_CASE("a folder is watched when a recursive root covers it") {
  TemporaryCatalog catalog;
  catalog->register_photo("/photos/trip/a.arw", sample("Sony", 100), false);
  catalog->register_photo("/photos/other/b.arw", sample("Sony", 100), false);
  catalog->register_photo("/photos/tripwire/c.arw", sample("Sony", 100), false);
  catalog->watch_folder("/photos/trip", true);

  const std::vector<CatalogFolder> folders = catalog->folders();
  REQUIRE(folders.size() == 3);
  const auto watched = [&folders](const std::string& path) {
    for (const CatalogFolder& folder : folders) {
      if (folder.path == path) return folder.watched;
    }
    FAIL("folder missing: " + path);
    return false;
  };
  REQUIRE(watched("/photos/trip"));
  REQUIRE(!watched("/photos/other"));
  // The root is a path prefix of this one, but not a parent of it.
  REQUIRE(!watched("/photos/tripwire"));
}

TEST_CASE("a non-recursive root covers only itself") {
  TemporaryCatalog catalog;
  catalog->register_photo("/photos/trip/a.arw", sample("Sony", 100), false);
  catalog->register_photo("/photos/trip/raw/b.arw", sample("Sony", 100), false);
  catalog->watch_folder("/photos/trip", false);

  const std::vector<CatalogFolder> folders = catalog->folders();
  REQUIRE(folders.at(0).path == "/photos/trip");
  REQUIRE(folders.at(0).watched);
  REQUIRE(folders.at(1).path == "/photos/trip/raw");
  REQUIRE(!folders.at(1).watched);
}

TEST_CASE("opening an old catalog drops rasters the scan once imported as photos") {
  TemporaryCatalog catalog;
  catalog->register_photo("/photos/a.arw", sample("Sony A6400", 100), true);
  catalog->register_photo("/photos/a.arw.latent.d/masks/m1.0123456789abcdef.png", sample("", 0),
                          false);
  catalog->register_photo("/photos/a.arw.latent.d/depth.png", sample("", 0), false);
  catalog->register_photo("/photos/b.latent.png", sample("", 0), false);

  // Back to the schema version before the scan knew about `*.latent.d/`.
  sqlite3* db = nullptr;
  REQUIRE(sqlite3_open(catalog.path().c_str(), &db) == SQLITE_OK);
  REQUIRE(sqlite3_exec(db, "PRAGMA user_version=2", nullptr, nullptr, nullptr) == SQLITE_OK);
  sqlite3_close(db);

  Catalog reopened(catalog.path());
  REQUIRE(reopened.find_by_path("/photos/a.arw").has_value());
  REQUIRE(reopened.find_by_path("/photos/b.latent.png").has_value());
  REQUIRE(!reopened.find_by_path("/photos/a.arw.latent.d/depth.png").has_value());
  REQUIRE(reopened.list({}).total == 2);
}
