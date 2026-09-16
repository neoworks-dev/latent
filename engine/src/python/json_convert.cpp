#include "python/json_convert.h"

#include <string>

namespace py = pybind11;

namespace latent {

py::object json_to_python(const nlohmann::json& value) {
  if (value.is_null()) return py::none();
  if (value.is_boolean()) return py::bool_(value.get<bool>());
  if (value.is_number_integer()) return py::int_(value.get<int64_t>());
  if (value.is_number_unsigned()) return py::int_(value.get<uint64_t>());
  if (value.is_number_float()) return py::float_(value.get<double>());
  if (value.is_string()) return py::str(value.get<std::string>());
  if (value.is_array()) {
    py::list items;
    for (const nlohmann::json& item : value) {
      items.append(json_to_python(item));
    }
    return items;
  }
  py::dict items;
  for (auto entry = value.begin(); entry != value.end(); ++entry) {
    items[py::str(entry.key())] = json_to_python(entry.value());
  }
  return items;
}

nlohmann::json python_to_json(const py::handle& value) {
  if (value.is_none()) return nullptr;
  if (py::isinstance<py::bool_>(value)) return value.cast<bool>();
  if (py::isinstance<py::int_>(value)) return value.cast<int64_t>();
  if (py::isinstance<py::float_>(value)) return value.cast<double>();
  if (py::isinstance<py::str>(value)) return value.cast<std::string>();
  if (py::isinstance<py::bytes>(value)) return value.cast<std::string>();
  if (py::isinstance<py::dict>(value)) {
    nlohmann::json object = nlohmann::json::object();
    for (const auto& entry : value.cast<py::dict>()) {
      object[py::str(entry.first).cast<std::string>()] = python_to_json(entry.second);
    }
    return object;
  }
  if (py::isinstance<py::list>(value) || py::isinstance<py::tuple>(value)) {
    nlohmann::json array = nlohmann::json::array();
    for (const py::handle& item : value) {
      array.push_back(python_to_json(item));
    }
    return array;
  }
  throw py::type_error("cannot convert " + py::str(value.get_type()).cast<std::string>() +
                       " to a JSON value");
}

}  // namespace latent
