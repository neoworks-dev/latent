// The `latent` module: the single API surface for scripts, the console and MCP agents
// (PROMPT.md 3.4). Everything here writes through EngineApi, so a Python edit is the same
// mutation an RPC would have made — one op-stack, one history, one sidecar.
#include "python/module.h"

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
struct DevelopRef {
  int64_t photo_id = 0;
};
struct RenderRef {};
struct CatalogRef {};

py::object make_photo(int64_t id);

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
      .def("remove",
           [](const StackRef& self, const OpRef& op) {
             edit_stack(self.photo_id, [&](Stack& stack) {
               const auto found = std::find_if(stack.begin(), stack.end(), [&](const Op& entry) {
                 return entry.id == op.op_id;
               });
               if (found == stack.end()) throw std::runtime_error("latent: op is gone");
               stack.erase(found);
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
               stack.push_back(Op{make_op_id(), name, params, std::nullopt, true});
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

void bind_services(py::module_& module) {
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
  bind_op(module);
  bind_stack(module);
  bind_develop(module);
  bind_photo(module);
  bind_services(module);
  module.attr("render") = py::cast(RenderRef{});
  module.attr("catalog") = py::cast(CatalogRef{});

  // PEP 562: `latent.photo` has to be looked up per access, and a module attribute cannot
  // be a property. Everything else resolves normally and never reaches this.
  module.def("__getattr__", [](const std::string& name) -> py::object {
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
      [](const py::object& photo_id, uint32_t max_size) {
        return preview_jpeg(resolve_photo(photo_id.is_none() ? 0 : photo_id.cast<int64_t>()),
                            max_size, py::none());
      },
      py::arg("photo_id") = py::none(), py::arg("max_size") = 1024);
}

}  // namespace latent
