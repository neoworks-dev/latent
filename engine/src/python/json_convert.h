// nlohmann::json <-> Python objects. pybind11 has no built-in caster for it, and a
// caster would hide where the GIL is required: both directions below touch Python
// objects, so the caller must hold it.
#pragma once

#include <nlohmann/json.hpp>
#include <pybind11/pybind11.h>

namespace latent {

pybind11::object json_to_python(const nlohmann::json& value);
nlohmann::json python_to_json(const pybind11::handle& value);

}  // namespace latent
