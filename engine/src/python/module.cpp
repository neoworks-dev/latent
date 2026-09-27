// The `latent` module: the single API surface for scripts, the console and MCP agents
// (PROMPT.md 3.4). Everything here writes through EngineApi, so a Python edit is the same
// mutation an RPC would have made — one op-stack, one history, one sidecar.
#include "python/module.h"

#include "generative/generative.h"
#include "ops/mask.h"
#include "ops/registry.h"
#include "python/json_convert.h"

#include <algorithm>
#include <exception>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <pybind11/embed.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

namespace py = pybind11;

namespace latent {

namespace {

EngineApi* g_engine = nullptr;
int64_t g_bound_photo = 0;

// Set by PythonHost; without it (tests, a host that never installed one) a script still
// runs, just without the timeout.
python_module::ScriptRunner& script_runner() {
  static python_module::ScriptRunner runner;
  return runner;
}

python_module::RunResult run_script(const std::string& code, int64_t photo_id,
                                    const std::string& source) {
  if (script_runner()) return script_runner()(code, photo_id, source);
  return python_module::run_code(code, photo_id, source, {});
}
// Function-local so nothing throws before main(); every access holds the GIL.
std::string& current_source() {
  static std::string source = "python";
  return source;
}

EngineApi& engine() {
  if (g_engine == nullptr) throw std::runtime_error("latent: the engine is not running");
  return *g_engine;
}

// THREADING RULE. The server thread owns the GPU, the op-stack and the socket, so every
// engine call has to happen there. A script started by `python.run` already runs on it and
// calls straight through. An MCP tool runs on the SDK's uvicorn thread instead: it hands
// the work over with EngineApi::run_on_server_thread and drops the GIL while it waits —
// without that the server thread could never acquire the GIL to do the work, and the two
// threads would deadlock on the first tool call.
template <typename Body>
auto on_engine(Body&& body) -> decltype(body()) {
  using Result = decltype(body());
  if (engine().on_server_thread()) return body();
  std::optional<Result> result;
  std::exception_ptr failure;
  {
    const py::gil_scoped_release release;
    engine().run_on_server_thread([&] {
      try {
        result = body();
      } catch (...) {
        failure = std::current_exception();
      }
    });
  }
  if (failure) std::rethrow_exception(failure);
  if (!result.has_value()) throw std::runtime_error("latent: the engine dropped the request");
  return std::move(*result);
}

int64_t resolve_photo(int64_t requested) {
  if (requested > 0) return requested;
  if (g_bound_photo > 0) return g_bound_photo;
  const int64_t current = on_engine([] { return engine().current_photo(); });
  if (current <= 0) throw std::runtime_error("latent: no photo is open");
  return current;
}

// Read-modify-write of one photo's stack, atomic because it all happens in one hop onto
// the server thread. Every call is one history snapshot and one sidecar write.
template <typename Edit>
void edit_stack(int64_t photo_id, Edit&& edit) {
  const std::string source = current_source();
  on_engine([&] {
    Stack next = engine().photo_stack(photo_id);
    edit(next);
    engine().set_photo_stack(photo_id, std::move(next), source);
    return true;
  });
}

Op& require_op(Stack& stack, const std::string& op_id) {
  Op* found = find_op(stack, op_id);
  if (found == nullptr) throw std::runtime_error("latent: op '" + op_id + "' is gone");
  return *found;
}

nlohmann::json op_json(int64_t photo_id, const std::string& op_id) {
  return on_engine([&] {
    Stack stack = engine().photo_stack(photo_id);
    return op_to_json(require_op(stack, op_id));
  });
}

const OpDefinition& require_definition(const std::string& name) {
  const OpDefinition* definition = find_op_definition(name);
  if (definition == nullptr) throw std::runtime_error("latent: unknown op '" + name + "'");
  return *definition;
}

nlohmann::json normalized(const std::string& name, const nlohmann::json& params, int64_t photo_id) {
  std::vector<std::string> warnings;
  nlohmann::json out = normalize_params(require_definition(name), params, warnings);
  for (const std::string& warning : warnings) {
    engine().warn(warning, photo_id);
  }
  return out;
}

// The develop sugar resolves to one op and one param: every op whose only param is
// `value` is reachable by its own name, plus white_balance's two named params.
std::pair<std::string, std::string> develop_target(const std::string& attribute) {
  if (attribute == "temperature" || attribute == "tint") return {"white_balance", attribute};
  const OpDefinition* definition = find_op_definition(attribute);
  const bool single_value = definition != nullptr && definition->params.size() == 1 &&
                            definition->params[0].name == "value";
  if (!single_value) throw py::attribute_error("develop has no attribute '" + attribute + "'");
  return {attribute, "value"};
}

nlohmann::json default_param(const std::string& op_name, const std::string& param_name) {
  for (const OpParamSpec& spec : require_definition(op_name).params) {
    if (spec.name == param_name) return spec.default_value;
  }
  return 0.0;
}

// Setting targets the unmasked base op, so `develop.exposure = 1` never edits a masked
// exposure op the user painted somewhere (PROMPT.md 3.4).
Op* find_base_op(Stack& stack, const std::string& name) {
  for (Op& op : stack) {
    if (op.name == name && !op.mask.has_value()) return &op;
  }
  return nullptr;
}

struct PhotoRef {
  int64_t id = 0;
};
struct StackRef {
  int64_t photo_id = 0;
};
struct OpRef {
  int64_t photo_id = 0;
  std::string op_id;
};
struct ParamsRef {
  int64_t photo_id = 0;
  std::string op_id;
};
struct MaskRef {
  int64_t photo_id = 0;
  std::string op_id;
};
struct MasksRef {
  int64_t photo_id = 0;
};
struct GenerativeRef {};
struct DevelopRef {
  int64_t photo_id = 0;
};
struct RenderRef {};
struct CatalogRef {};

py::object make_photo(int64_t id);

// `photos=` on latent.export: a Photo, an id, a list of either, or None for the current
// photo. Everything an agent or a script is likely to have in hand.
std::vector<int64_t> export_photo_ids(const py::object& photos) {
  const auto one = [](const py::handle& entry) -> int64_t {
    if (py::isinstance<PhotoRef>(entry)) return entry.cast<PhotoRef>().id;
    return entry.cast<int64_t>();
  };
  if (photos.is_none()) return {resolve_photo(0)};
  if (py::isinstance<py::list>(photos) || py::isinstance<py::tuple>(photos)) {
    std::vector<int64_t> ids;
    for (const py::handle& entry : photos) {
      ids.push_back(one(entry));
    }
    if (ids.empty()) throw py::value_error("export needs at least one photo");
    return ids;
  }
  return {one(photos)};
}

py::list photo_list(const std::vector<PhotoSummary>& photos) {
  py::list out;
  for (const PhotoSummary& photo : photos) {
    out.append(make_photo(photo.id));
  }
  return out;
}

std::optional<PreviewRegion> region_from(const py::object& value) {
  if (value.is_none()) return std::nullopt;
  const auto box = value.cast<std::vector<double>>();
  if (box.size() != 4) throw py::value_error("region must be (x0, y0, x1, y1) in 0..1");
  return PreviewRegion{box[0], box[1], box[2], box[3]};
}

py::bytes preview_jpeg(int64_t photo_id, uint32_t max_size, const py::object& region) {
  const std::optional<PreviewRegion> box = region_from(region);
  const std::vector<uint8_t> jpeg =
      on_engine([&] { return engine().render_preview_jpeg(photo_id, max_size, box); });
  return py::bytes(reinterpret_cast<const char*>(jpeg.data()), jpeg.size());
}

void bind_params(py::module_& module) {
  py::class_<ParamsRef>(module, "OpParams",
                        "Mutable view of one op's params; writes go straight to the engine.")
      .def(
          "__len__",
          [](const ParamsRef& self) { return op_json(self.photo_id, self.op_id)["params"].size(); })
      .def("__contains__",
           [](const ParamsRef& self, const std::string& key) {
             return op_json(self.photo_id, self.op_id)["params"].contains(key);
           })
      .def("__getitem__",
           [](const ParamsRef& self, const std::string& key) {
             const nlohmann::json params = op_json(self.photo_id, self.op_id)["params"];
             if (!params.contains(key)) throw py::key_error(key);
             return json_to_python(params[key]);
           })
      .def("__setitem__",
           [](const ParamsRef& self, const std::string& key, const py::object& value) {
             const nlohmann::json update = python_to_json(value);
             edit_stack(self.photo_id, [&](Stack& stack) {
               Op& op = require_op(stack, self.op_id);
               nlohmann::json merged = op.params;
               merged[key] = update;
               op.params = normalized(op.name, merged, self.photo_id);
             });
           })
      .def("__iter__",
           [](const ParamsRef& self) {
             return py::iter(json_to_python(op_json(self.photo_id, self.op_id)["params"]));
           })
      .def("keys",
           [](const ParamsRef& self) {
             return json_to_python(op_json(self.photo_id, self.op_id)["params"]).attr("keys")();
           })
      .def("items",
           [](const ParamsRef& self) {
             return json_to_python(op_json(self.photo_id, self.op_id)["params"]).attr("items")();
           })
      .def(
          "get",
          [](const ParamsRef& self, const std::string& key, const py::object& fallback) {
            const nlohmann::json params = op_json(self.photo_id, self.op_id)["params"];
            if (!params.contains(key)) return fallback;
            return json_to_python(params[key]);
          },
          py::arg("key"), py::arg("default") = py::none())
      .def("update",
           [](const ParamsRef& self, const py::dict& values) {
             const nlohmann::json update = python_to_json(values);
             edit_stack(self.photo_id, [&](Stack& stack) {
               Op& op = require_op(stack, self.op_id);
               nlohmann::json merged = op.params;
               merged.update(update);
               op.params = normalized(op.name, merged, self.photo_id);
             });
           })
      .def("to_dict",
           [](const ParamsRef& self) {
             return json_to_python(op_json(self.photo_id, self.op_id)["params"]);
           })
      .def("__repr__", [](const ParamsRef& self) {
        return op_json(self.photo_id, self.op_id)["params"].dump();
      });
}

nlohmann::json mask_json(int64_t photo_id, const std::string& op_id) {
  const nlohmann::json op = op_json(photo_id, op_id);
  if (!op.contains("mask")) return {{"components", nlohmann::json::array()}};
  return op["mask"];
}

// Component-level keys live beside `params` in the schema, everything else is a param, so
// `mask.add("radial", center=[0.4, 0.5], feather=70)` reads the way it looks.
bool is_component_field(const std::string& key) {
  return key == "id" || key == "mode" || key == "invert" || key == "feather" || key == "opacity";
}

std::string add_op_to_group(int64_t photo_id, const std::string& group_id, const std::string& name,
                            const nlohmann::json& params) {
  const OpDefinition& definition = require_definition(name);
  if (!definition.maskable() || is_generative_op(name)) {
    throw py::value_error("latent: '" + name + "' cannot sit inside a group");
  }
  const std::string op_id = make_op_id();
  const nlohmann::json normalised = normalized(name, params, photo_id);
  edit_stack(photo_id, [&](Stack& stack) {
    Op& group = require_op(stack, group_id);
    if (!group.is_group()) throw std::runtime_error("latent: op '" + group_id + "' is not a group");
    Op op;
    op.id = op_id;
    op.name = name;
    op.params = normalised;
    group.ops.push_back(std::move(op));
  });
  return op_id;
}

// Applying a preset replaces the unmasked op of the same name when there is one, so the
// same preset twice is idempotent instead of stacking two exposures.
void apply_ops(int64_t photo_id, const py::iterable& ops) {
  std::vector<nlohmann::json> incoming;
  for (const py::handle& item : ops) {
    py::object value = py::reinterpret_borrow<py::object>(item);
    if (py::isinstance<OpRef>(value)) value = value.attr("to_dict")();
    incoming.push_back(python_to_json(value));
  }
  edit_stack(photo_id, [&](Stack& stack) {
    for (const nlohmann::json& entry : incoming) {
      Op op = op_from_json(entry);
      op.params = normalized(op.name, op.params, photo_id);
      Op* base = find_base_op(stack, op.name);
      if (base == nullptr) {
        op.id = make_op_id();
        stack.push_back(std::move(op));
        continue;
      }
      base->params = op.params;
      base->enabled = op.enabled;
    }
  });
}

void bind_mask(py::module_& module) {
  py::class_<MaskRef>(module, "OpMask",
                      "One op's mask: a component list combined top-down (PROMPT.md 3.7).")
      .def("__len__",
           [](const MaskRef& self) {
             return mask_json(self.photo_id, self.op_id)["components"].size();
           })
      .def("__iter__",
           [](const MaskRef& self) {
             return py::iter(json_to_python(mask_json(self.photo_id, self.op_id)["components"]));
           })
      .def("__getitem__",
           [](const MaskRef& self, int64_t index) {
             const nlohmann::json components = mask_json(self.photo_id, self.op_id)["components"];
             const int64_t at = index < 0 ? index + static_cast<int64_t>(components.size()) : index;
             if (at < 0 || at >= static_cast<int64_t>(components.size())) throw py::index_error();
             return json_to_python(components[static_cast<size_t>(at)]);
           })
      .def("to_list",
           [](const MaskRef& self) {
             return json_to_python(mask_json(self.photo_id, self.op_id)["components"]);
           })
      .def(
          "add",
          [](const MaskRef& self, const std::string& kind, const py::kwargs& fields) {
            nlohmann::json component = {{"id", make_op_id()}, {"kind", kind}, {"mode", "add"}};
            nlohmann::json params = nlohmann::json::object();
            for (const auto& field : fields) {
              const auto key = field.first.cast<std::string>();
              const nlohmann::json value =
                  python_to_json(py::reinterpret_borrow<py::object>(field.second));
              if (is_component_field(key)) {
                component[key] = value;
              } else {
                params[key] = value;
              }
            }
            component["params"] = params;
            const auto component_id = component["id"].get<std::string>();
            edit_stack(self.photo_id, [&](Stack& stack) {
              Op& op = require_op(stack, self.op_id);
              nlohmann::json mask =
                  op.mask.value_or(nlohmann::json{{"components", nlohmann::json::array()}});
              mask["components"].push_back(component);
              op.mask = normalize_mask(mask);
            });
            return component_id;
          },
          py::arg("kind"))
      .def(
          "remove",
          [](const MaskRef& self, const std::string& component_id) {
            edit_stack(self.photo_id, [&](Stack& stack) {
              Op& op = require_op(stack, self.op_id);
              if (!op.mask.has_value()) throw std::runtime_error("latent: the op has no mask");
              nlohmann::json kept = nlohmann::json::array();
              for (const nlohmann::json& component : (*op.mask)["components"]) {
                if (component.value("id", std::string()) == component_id) continue;
                kept.push_back(component);
              }
              // An op with no components left has no mask: it applies everywhere again.
              if (kept.empty()) {
                op.mask.reset();
                return;
              }
              op.mask = normalize_mask(nlohmann::json{{"components", kept}});
            });
          },
          py::arg("component_id"))
      .def("clear",
           [](const MaskRef& self) {
             edit_stack(self.photo_id,
                        [&](Stack& stack) { require_op(stack, self.op_id).mask.reset(); });
           })
      .def("__repr__",
           [](const MaskRef& self) { return mask_json(self.photo_id, self.op_id).dump(); });
}

void bind_op(py::module_& module) {
  py::class_<OpRef>(module, "Op", "One entry of the op-stack.")
      .def_property_readonly("id", [](const OpRef& self) { return self.op_id; })
      .def_property_readonly("op",
                             [](const OpRef& self) {
                               return op_json(self.photo_id, self.op_id)["op"].get<std::string>();
                             })
      .def_property_readonly("params",
                             [](const OpRef& self) { return ParamsRef{self.photo_id, self.op_id}; })
      .def_property(
          "enabled",
          [](const OpRef& self) {
            return op_json(self.photo_id, self.op_id)["enabled"].get<bool>();
          },
          [](const OpRef& self, bool enabled) {
            edit_stack(self.photo_id,
                       [&](Stack& stack) { require_op(stack, self.op_id).enabled = enabled; });
          })
      .def_property_readonly("mask",
                             [](const OpRef& self) { return MaskRef{self.photo_id, self.op_id}; })
      .def_property(
          "opacity",
          [](const OpRef& self) {
            // Absent on the wire means 100 (protocol Op.opacity).
            return op_json(self.photo_id, self.op_id).value("opacity", kFullOpacity);
          },
          [](const OpRef& self, double opacity) {
            if (!(opacity >= 0 && opacity <= kFullOpacity)) {
              throw py::value_error("opacity must be between 0 and 100");
            }
            edit_stack(self.photo_id,
                       [&](Stack& stack) { require_op(stack, self.op_id).opacity = opacity; });
          })
      // Generative ops only (PROMPT.md 3.5): the cached raster's path, the hash it was made
      // from, and whether the stack has moved under it since. Empty on every other op.
      .def_property_readonly(
          "result",
          [](const OpRef& self) {
            return op_json(self.photo_id, self.op_id).value("result", std::string());
          })
      .def_property_readonly("stale",
                             [](const OpRef& self) {
                               return on_engine([&] {
                                 const Stack stack = engine().photo_stack(self.photo_id);
                                 const Op* op = find_op(stack, self.op_id);
                                 return op != nullptr && generative_is_stale(stack, *op);
                               });
                             })
      .def("run",
           [](const OpRef& self) {
             // Returns the jobId. The op is untouched until the job lands, and nothing in
             // the engine ever starts one on its own.
             return on_engine([&] { return engine().run_generative(self.photo_id, self.op_id); });
           })
      // Groups (PROMPT.md 3.7): a layer is one mask and the adjustments under it.
      .def_property_readonly("is_group",
                             [](const OpRef& self) {
                               return op_json(self.photo_id, self.op_id)["op"].get<std::string>() ==
                                      kGroupOpName;
                             })
      .def_property_readonly(
          "ops",
          [](const OpRef& self) {
            const nlohmann::json op = op_json(self.photo_id, self.op_id);
            py::list items;
            if (!op.contains("ops")) return items;
            for (const nlohmann::json& child : op["ops"]) {
              items.append(py::cast(OpRef{self.photo_id, child["id"].get<std::string>()}));
            }
            return items;
          })
      .def(
          "add",
          [](const OpRef& self, const std::string& name, const py::kwargs& params) {
            return OpRef{self.photo_id,
                         add_op_to_group(self.photo_id, self.op_id, name, python_to_json(params))};
          },
          py::arg("op"), "Adds an adjustment under this group's mask. Groups only (PROMPT.md 3.7).")
      .def("to_dict",
           [](const OpRef& self) { return json_to_python(op_json(self.photo_id, self.op_id)); })
      .def("__repr__", [](const OpRef& self) {
        const nlohmann::json op = op_json(self.photo_id, self.op_id);
        return "<latent.Op " + op["id"].get<std::string>() + " " + op["op"].get<std::string>() +
               " " + op["params"].dump() + ">";
      });
}

std::string add_op(int64_t photo_id, const std::string& name, const nlohmann::json& params,
                   const py::object& index) {
  const std::string op_id = make_op_id();
  edit_stack(photo_id, [&](Stack& stack) {
    Op op;
    op.id = op_id;
    op.name = name;
    op.params = normalized(name, params, photo_id);
    size_t at = stack.size();
    if (!index.is_none()) {
      const auto requested = index.cast<int64_t>();
      at = static_cast<size_t>(
          std::min<int64_t>(std::max<int64_t>(requested, 0), static_cast<int64_t>(stack.size())));
    }
    stack.insert(stack.begin() + static_cast<ptrdiff_t>(at), std::move(op));
  });
  return op_id;
}

// A new layer: a group with an empty mask, ready for `.mask.add(...)` and `.add(...)`.
std::string add_group(int64_t photo_id, const py::object& index) {
  const std::string op_id = make_op_id();
  edit_stack(photo_id, [&](Stack& stack) {
    Op group;
    group.id = op_id;
    group.name = std::string(kGroupOpName);
    size_t at = stack.size();
    if (!index.is_none()) {
      const auto requested = index.cast<int64_t>();
      at = static_cast<size_t>(
          std::min<int64_t>(std::max<int64_t>(requested, 0), static_cast<int64_t>(stack.size())));
    }
    stack.insert(stack.begin() + static_cast<ptrdiff_t>(at), std::move(group));
  });
  return op_id;
}

void bind_stack(py::module_& module) {
  py::class_<StackRef>(module, "OpStack", "The ordered op list: the truth about an edit.")
      .def("__len__",
           [](const StackRef& self) {
             return on_engine([&] { return engine().photo_stack(self.photo_id).size(); });
           })
      .def("__getitem__",
           [](const StackRef& self, int64_t index) {
             const Stack stack = on_engine([&] { return engine().photo_stack(self.photo_id); });
             const int64_t at = index < 0 ? index + static_cast<int64_t>(stack.size()) : index;
             if (at < 0 || at >= static_cast<int64_t>(stack.size())) throw py::index_error();
             return OpRef{self.photo_id, stack[static_cast<size_t>(at)].id};
           })
      .def("__iter__",
           [](const StackRef& self) {
             const Stack stack = on_engine([&] { return engine().photo_stack(self.photo_id); });
             py::list items;
             for (const Op& op : stack) {
               items.append(py::cast(OpRef{self.photo_id, op.id}));
             }
             return py::iter(items);
           })
      .def(
          "add",
          [](const StackRef& self, const std::string& name, const py::object& index,
             const py::kwargs& params) {
            return OpRef{self.photo_id, add_op(self.photo_id, name, python_to_json(params), index)};
          },
          py::arg("op"), py::arg("index") = py::none())
      .def(
          "group",
          [](const StackRef& self, const py::object& index) {
            return OpRef{self.photo_id, add_group(self.photo_id, index)};
          },
          py::arg("index") = py::none(),
          "A new layer: an empty group. Give it a mask with `.mask.add(kind)` and the "
          "adjustments that share it with `.add(op, **params)` (PROMPT.md 3.7).")
      .def("remove",
           [](const StackRef& self, const OpRef& op) {
             edit_stack(self.photo_id, [&](Stack& stack) {
               // A child goes from its group, and a group goes with its children.
               Op* parent = find_parent_group(stack, op.op_id);
               Stack& from = parent == nullptr ? stack : parent->ops;
               const auto found = std::find_if(
                   from.begin(), from.end(), [&](const Op& entry) { return entry.id == op.op_id; });
               if (found == from.end()) throw std::runtime_error("latent: op is gone");
               from.erase(found);
             });
           })
      .def("apply",
           [](const StackRef& self, const py::iterable& ops) { apply_ops(self.photo_id, ops); })
      .def(
          "preset",
          [](const StackRef& self, const std::vector<std::string>& names) {
            const Stack stack = on_engine([&] { return engine().photo_stack(self.photo_id); });
            py::list out;
            for (const Op& op : stack) {
              if (std::find(names.begin(), names.end(), op.name) == names.end()) continue;
              out.append(json_to_python(op_to_json(op)));
            }
            return out;
          },
          py::arg("names"))
      .def("to_list",
           [](const StackRef& self) {
             return json_to_python(
                 on_engine([&] { return stack_to_json(engine().photo_stack(self.photo_id)); }));
           })
      .def("__repr__", [](const StackRef& self) {
        return on_engine([&] { return stack_to_json(engine().photo_stack(self.photo_id)).dump(); });
      });
}

void bind_develop(py::module_& module) {
  py::class_<DevelopRef>(module, "Develop", "Lightroom-flat sugar over the op-stack.")
      .def("__getattr__",
           [](const DevelopRef& self, const std::string& attribute) {
             const auto [name, param] = develop_target(attribute);
             return on_engine([&, name = name, param = param] {
               Stack stack = engine().photo_stack(self.photo_id);
               Op* base = find_base_op(stack, name);
               if (base != nullptr) return json_to_python(base->params.value(param, 0.0));
               return json_to_python(default_param(name, param));
             });
           })
      .def("__setattr__",
           [](const DevelopRef& self, const std::string& attribute, const py::object& value) {
             const auto [name, param] = develop_target(attribute);
             const nlohmann::json number = python_to_json(value);
             edit_stack(self.photo_id, [&, name = name, param = param](Stack& stack) {
               Op* base = find_base_op(stack, name);
               nlohmann::json merged = base == nullptr ? nlohmann::json::object() : base->params;
               merged[param] = number;
               const nlohmann::json params = normalized(name, merged, self.photo_id);
               if (base != nullptr) {
                 base->params = params;
                 return;
               }
               Op created;
               created.id = make_op_id();
               created.name = name;
               created.params = params;
               stack.push_back(std::move(created));
             });
           })
      .def("__dir__", [](const DevelopRef&) {
        py::list names;
        names.append("temperature");
        names.append("tint");
        for (const OpDefinition& definition : op_definitions()) {
          const bool single = definition.params.size() == 1 && definition.params[0].name == "value";
          if (single) names.append(definition.name);
        }
        return names;
      });
}

void bind_photo(py::module_& module) {
  py::class_<PhotoRef>(module, "Photo", "One open photo: its stack, its develop sugar, its pixels.")
      .def_property_readonly("id", [](const PhotoRef& self) { return self.id; })
      .def_property_readonly(
          "path",
          [](const PhotoRef& self) {
            return on_engine([&] { return engine().photo_summary(self.id); }).path;
          })
      .def_property_readonly(
          "filename",
          [](const PhotoRef& self) {
            return on_engine([&] { return engine().photo_summary(self.id); }).filename;
          })
      .def_property_readonly(
          "camera",
          [](const PhotoRef& self) {
            return on_engine([&] { return engine().photo_summary(self.id); }).camera;
          })
      .def_property_readonly(
          "width",
          [](const PhotoRef& self) {
            return on_engine([&] { return engine().photo_summary(self.id); }).width;
          })
      .def_property_readonly(
          "height",
          [](const PhotoRef& self) {
            return on_engine([&] { return engine().photo_summary(self.id); }).height;
          })
      .def_property_readonly("stack", [](const PhotoRef& self) { return StackRef{self.id}; })
      .def_property_readonly("develop", [](const PhotoRef& self) { return DevelopRef{self.id}; })
      .def_property_readonly("masks", [](const PhotoRef& self) { return MasksRef{self.id}; })
      .def("stack_json",
           [](const PhotoRef& self) {
             return json_to_python(
                 on_engine([&] { return stack_to_json(engine().photo_stack(self.id)); }));
           })
      .def("state",
           [](const PhotoRef& self) {
             return json_to_python(on_engine([&] { return engine().agent_stack_state(self.id); }));
           })
      .def("histogram",
           [](const PhotoRef& self) {
             const nlohmann::json state =
                 on_engine([&] { return engine().agent_stack_state(self.id); });
             return json_to_python(state.value("histogram", nlohmann::json::object()));
           })
      .def(
          "preview",
          [](const PhotoRef& self, uint32_t max_size, const py::object& region) {
            return preview_jpeg(self.id, max_size, region);
          },
          py::arg("max") = 1024, py::arg("region") = py::none())
      // Depth (PROMPT.md 3.8). `estimate_depth` returns a jobId and the map arrives later,
      // like every other model run; `has_depth` says whether one is there now. A relight op
      // renders nothing until it is.
      .def("estimate_depth",
           [](const PhotoRef& self) {
             return on_engine([&] { return engine().estimate_depth(self.id); });
           })
      .def_property_readonly("has_depth",
                             [](const PhotoRef& self) {
                               return on_engine([&] { return engine().has_depth(self.id); });
                             })
      .def("undo",
           [](const PhotoRef& self) { return on_engine([&] { return engine().undo(self.id); }); })
      .def("redo",
           [](const PhotoRef& self) { return on_engine([&] { return engine().redo(self.id); }); })
      .def("__repr__", [](const PhotoRef& self) {
        const PhotoSummary summary = on_engine([&] { return engine().photo_summary(self.id); });
        return "<latent.Photo " + std::to_string(self.id) + " " + summary.filename + ">";
      });
}

py::object make_photo(int64_t id) {
  return py::cast(PhotoRef{id});
}

py::bytes mask_png(int64_t photo_id, const std::string& op_id, const py::object& component_id,
                   uint32_t max_size) {
  const std::string component =
      component_id.is_none() ? std::string() : component_id.cast<std::string>();
  const std::vector<uint8_t> png =
      on_engine([&] { return engine().render_mask_png(photo_id, op_id, component, max_size); });
  return {reinterpret_cast<const char*>(png.data()), png.size()};
}

void bind_services(py::module_& module) {
  py::class_<MasksRef>(module, "Masks", "The AI mask jobs and rasters of one photo.")
      .def(
          "detect",
          [](const MasksRef& self, const std::string& op_id, const std::string& component_id) {
            // Returns the jobId; the component is `pending` until job.progress finishes.
            return on_engine(
                [&] { return engine().detect_mask(self.photo_id, op_id, component_id); });
          },
          py::arg("op_id"), py::arg("component_id"))
      .def(
          "preview",
          [](const MasksRef& self, const std::string& op_id, const py::object& component_id,
             uint32_t max_size) { return mask_png(self.photo_id, op_id, component_id, max_size); },
          py::arg("op_id"), py::arg("component_id") = py::none(), py::arg("max") = 1024);

  py::class_<GenerativeRef>(module, "Generative",
                            "The generative backends: which one is selected, whether ComfyUI "
                            "is reachable, and which graphs have their weights.")
      .def("status", [](const GenerativeRef&) {
        // Spawns the `comfy` CLI, so it blocks the server thread for as long as a Python
        // process takes to start. Fine for a script or an agent; never in a slider tick.
        return json_to_python(on_engine([] { return engine().generative_state(); }));
      });

  py::class_<RenderRef>(module, "Render")
      .def(
          "preview",
          [](const RenderRef&, uint32_t max_size, const py::object& region,
             const py::object& photo) {
            const int64_t id = photo.is_none() ? resolve_photo(0) : photo.cast<PhotoRef>().id;
            return preview_jpeg(id, max_size, region);
          },
          py::arg("max") = 1024, py::arg("region") = py::none(), py::arg("photo") = py::none());

  py::class_<CatalogRef>(module, "CatalogApi")
      .def("selected",
           [](const CatalogRef&) {
             return photo_list(on_engine([] { return engine().open_photos(); }));
           })
      .def(
          "photos",
          [](const CatalogRef&, int limit) {
            return json_to_python(on_engine([&] { return engine().catalog_list(limit); }));
          },
          py::arg("limit") = 200);
}

nlohmann::json clipping_of(const nlohmann::json& state) {
  const nlohmann::json histogram = state.value("histogram", nlohmann::json::object());
  return {{"shadowsPct", histogram.value("clippedShadowsPct", 0.0)},
          {"highlightsPct", histogram.value("clippedHighlightsPct", 0.0)}};
}

}  // namespace

namespace python_module {

void bind_engine(EngineApi* api) {
  g_engine = api;
}

void set_bound_photo(int64_t photo_id) {
  g_bound_photo = photo_id;
}

void set_source(std::string source) {
  current_source() = std::move(source);
}

void set_script_runner(ScriptRunner runner) {
  script_runner() = std::move(runner);
}

RunResult run_code(const std::string& code, int64_t photo_id, const std::string& source,
                   const OutputSink& sink) {
  set_bound_photo(photo_id);
  set_source(source);
  RunResult result;
  try {
    const py::object runner = py::module_::import("latent._runner").attr("run");
    py::object emit = py::none();
    // The sink runs on the server thread with the GIL held, which is exactly where the
    // socket lives, so it can push a notification per chunk without a hand-off.
    if (sink) emit = py::cpp_function(sink);
    const py::dict answer = runner(code, emit).cast<py::dict>();
    result.ok = answer["ok"].cast<bool>();
    result.out = answer["stdout"].cast<std::string>();
    result.err = answer["stderr"].cast<std::string>();
    result.has_value = !answer["value"].is_none();
    if (result.has_value) result.value = answer["value"].cast<std::string>();
  } catch (const py::error_already_set& error) {
    // The runner itself failed (missing module, syntax error in it). Report inside the
    // interpreter's lifetime: letting this escape crashes at teardown.
    result.ok = false;
    result.err = error.what();
  }
  set_bound_photo(0);
  set_source("python");
  return result;
}

}  // namespace python_module

PYBIND11_EMBEDDED_MODULE(latent, module) {
  module.doc() = "Latent engine API: the op-stack, the develop sugar, previews.";
  bind_params(module);
  bind_mask(module);
  bind_op(module);
  bind_stack(module);
  bind_develop(module);
  bind_photo(module);
  bind_services(module);
  module.attr("render") = py::cast(RenderRef{});
  module.attr("catalog") = py::cast(CatalogRef{});
  module.attr("generative") = py::cast(GenerativeRef{});

  // PEP 562: `latent.photo` has to be looked up per access, and a module attribute cannot
  // be a property. Everything else resolves normally and never reaches this.
  module.def("__getattr__", [](const std::string& name) -> py::object {
    // `latent.merge` is the pure-Python submodule; importing it here is what makes
    // `latent.merge.hdr(...)` work without an `import latent.merge` first.
    if (name == "merge") return py::module_::import("latent.merge");
    if (name != "photo") {
      throw py::attribute_error("module 'latent' has no attribute '" + name + "'");
    }
    return make_photo(resolve_photo(0));
  });

  module.def(
      "photos", [] { return photo_list(on_engine([] { return engine().open_photos(); })); },
      "Every photo the engine has open.");
  module.def(
      "undo",
      [](const py::object& photo) {
        const int64_t id = photo.is_none() ? resolve_photo(0) : photo.cast<PhotoRef>().id;
        return on_engine([&] { return engine().undo(id); });
      },
      py::arg("photo") = py::none());
  module.def(
      "redo",
      [](const py::object& photo) {
        const int64_t id = photo.is_none() ? resolve_photo(0) : photo.cast<PhotoRef>().id;
        return on_engine([&] { return engine().redo(id); });
      },
      py::arg("photo") = py::none());

  module.def(
      "export",
      [](const py::object& photos, const std::string& output_dir, const std::string& format,
         const std::string& color_space, const py::object& quality, const py::object& long_edge,
         const py::object& width, const py::object& height, const py::object& dpi,
         const py::object& sharpen, const std::string& sharpen_amount,
         const py::object& file_name_template) {
        nlohmann::json params;
        params["photoIds"] = export_photo_ids(photos);
        params["outputDir"] = output_dir;
        params["format"] = format;
        params["colorSpace"] = color_space;
        if (!quality.is_none()) params["quality"] = quality.cast<int>();
        nlohmann::json resize = nlohmann::json::object();
        if (!long_edge.is_none()) resize["longEdge"] = long_edge.cast<int>();
        if (!width.is_none()) resize["width"] = width.cast<int>();
        if (!height.is_none()) resize["height"] = height.cast<int>();
        if (!dpi.is_none()) resize["dpi"] = dpi.cast<int>();
        if (!resize.empty()) params["resize"] = resize;
        if (!sharpen.is_none()) {
          params["sharpen"] = {{"target", sharpen.cast<std::string>()}, {"amount", sharpen_amount}};
        }
        if (!file_name_template.is_none()) {
          params["fileNameTemplate"] = file_name_template.cast<std::string>();
        }
        return json_to_python(on_engine([&] { return engine().start_export(params); }));
      },
      py::arg("photos"), py::arg("output_dir"), py::arg("format") = "jpeg",
      py::arg("color_space") = "srgb", py::arg("quality") = py::none(),
      py::arg("long_edge") = py::none(), py::arg("width") = py::none(),
      py::arg("height") = py::none(), py::arg("dpi") = py::none(), py::arg("sharpen") = py::none(),
      py::arg("sharpen_amount") = "standard", py::arg("file_name_template") = py::none(),
      "Queue a batch export and return {jobId, total, files}. `photos` is a Photo, an id, "
      "a list of either, or None for the current photo. The files are written while the "
      "job runs; watch job.progress kind 'export' for its state.");

  // Photo Merge. The keyword surface lives in engine/python/latent/merge.py, because the
  // three merges and their preview differ only in which keys this dict carries.
  module.def(
      "_start_merge",
      [](const py::dict& request) {
        const nlohmann::json params = python_to_json(request);
        return json_to_python(on_engine([&] { return engine().start_merge(params); }));
      },
      py::arg("request"),
      "Queue a merge and return {jobId}. `request` is the merge.* params plus `kind` and "
      "`preview`; the merged photo's id arrives on the job's last job.progress.");

  // The underscored entry points are what engine/python/latent/mcp_server.py calls; they
  // take plain ids because an MCP client only ever has ids.
  module.def(
      "_run_code",
      // `tool` names the MCP tool the call came from; it reaches the UI as stack.changed's
      // `client` ("mcp:run_python"), while the wire's `source` stays "mcp".
      [](const std::string& code, const py::object& photo_id, const std::string& tool) {
        const int64_t id = photo_id.is_none() ? 0 : photo_id.cast<int64_t>();
        python_module::RunResult result;
        if (engine().on_server_thread()) {
          result = run_script(code, id, current_source());
        } else {
          const std::string source = tool.empty() ? "mcp" : "mcp:" + tool;
          const py::gil_scoped_release release;
          engine().run_on_server_thread([&] {
            const py::gil_scoped_acquire acquire;
            result = run_script(code, id, source);
          });
        }
        py::dict answer;
        answer["ok"] = result.ok;
        answer["stdout"] = result.out;
        answer["stderr"] = result.err;
        answer["value"] =
            result.has_value ? py::object(py::str(result.value)) : py::object(py::none());
        return answer;
      },
      py::arg("code"), py::arg("photo_id") = py::none(), py::arg("tool") = "run_python");
  module.def(
      "_stack_state",
      [](const py::object& photo_id) {
        const int64_t id = resolve_photo(photo_id.is_none() ? 0 : photo_id.cast<int64_t>());
        nlohmann::json state = on_engine([&] { return engine().agent_stack_state(id); });
        state["clipping"] = clipping_of(state);
        return json_to_python(state);
      },
      py::arg("photo_id") = py::none());
  module.def(
      "_list_photos",
      [](int limit) {
        return json_to_python(on_engine([&] { return engine().catalog_list(limit); }));
      },
      py::arg("limit") = 200);
  module.def(
      "_preview_jpeg",
      [](const py::object& photo_id, uint32_t max_size, const py::object& region) {
        return preview_jpeg(resolve_photo(photo_id.is_none() ? 0 : photo_id.cast<int64_t>()),
                            max_size, region);
      },
      py::arg("photo_id") = py::none(), py::arg("max_size") = 1024, py::arg("region") = py::none());
  // MCP's render_preview(mask=(op_id, component_id?)): the raster as PNG bytes, so an
  // agent can look at what it selected instead of guessing (PROMPT.md 3.7).
  module.def(
      "_preview_mask_png",
      [](const py::object& photo_id, const std::string& op_id, const py::object& component_id,
         uint32_t max_size) {
        return mask_png(resolve_photo(photo_id.is_none() ? 0 : photo_id.cast<int64_t>()), op_id,
                        component_id, max_size);
      },
      py::arg("photo_id"), py::arg("op_id"), py::arg("component_id") = py::none(),
      py::arg("max_size") = 1024);
}

}  // namespace latent
