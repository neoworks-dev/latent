# ComfyUI graphs

The engine never speaks to ComfyUI's HTTP API. It writes a crop and a mask, uploads both
with `comfy upload`, substitutes one of the compiled graphs below **by node id**, and runs
it with `comfy --json-stream run --workflow <filled> --wait --no-watch`
(PROMPT.md §3.5 step 4, `engine/src/generative/comfy_backend.cpp`).

One directory per graph:

| File | What it is |
| --- | --- |
| `fragment.json` | The graph as `comfy workflow decompose` produced it, plus its `_fragment` header: which widgets are named params and which sockets are ports |
| `blueprint.yaml` | What `comfy workflow compose` reads: one fragment, its inputs and the defaults |
| `workflow.json` | The compiled API-format graph. **A template.** The engine copies it, substitutes, and writes the copy into the job's temp directory; this file is never edited at run time |
| `bindings.json` | Which node id and widget each runtime value goes into, plus the weights the graph loads |

Rebuild after changing a fragment or a blueprint:

```sh
comfy workflow compose blueprint.yaml --lib <dir with fragment.json>   # writes <name>.compiled.json
```

`decompose` types a `LoadImage`-fed mask port as `IMAGE`. Both fragments here retype it
`MASK`, which is what makes the composer put an `ImageToMask{channel: "red"}` behind the
mask loader — Latent uploads an 8-bit grey PNG, not an image with an alpha channel. Without
that the graph feeds an IMAGE into `InpaintModelConditioning.mask` and fails at run time.

## The graphs

| Name | Task | Model | Runnable here |
| --- | --- | --- | --- |
| `inpaint-flux-fill` | `fill` | Flux.1 Fill Dev | **No** — needs ~24 GB of weights that are not installed |
| `inpaint-sdxl` | `fill` | Any SD/SDXL checkpoint, default `RealVisXL_V5.0_fp16.safetensors` | Yes |
| `remove` | `remove` | The same SDXL graph with a "nothing there" prompt and a lower CFG | Yes |
| `denoise` | `denoise` | SDXL img2img at a low denoise, default `RealVisXL_V5.0_fp16.safetensors` | Yes |
| `upscale` | `upscale` | `4x-UltraSharp.pth` through `ImageUpscaleWithModel` | Yes |

The last two are the whole-frame ops (issues #51, #52). Neither takes a mask, and the
engine hands each the frame the ops below it produced rather than a crop.

`denoise` is an img2img pass because this ComfyUI install has no restoration node — SCUNet,
Restormer and NAFNet are all custom nodes, and the honest fix is not a better graph but a
model in the **raw** domain, before demosaic, which is a pipeline change rather than another
workflow. Until then the sampler's `denoise` widget is the op's Strength, kept under 0.5:
above that an img2img pass stops cleaning the photograph and starts inventing another one.

`upscale` needs no sampler and no prompt. `ImageUpscaleWithModel` tiles the frame and blends
the seams itself, which is why a 24 MP photo goes through it in one run while `denoise` has
to be handed a 1536 px frame.

`generative.status` reports `ready` per graph by looking for every file in `requires`
under `<comfy workspace>/models/`. `choose_workflow` picks the first ready graph for the
task, so a machine that later downloads `flux1-fill-dev.safetensors` starts using the Flux
graph without any change here. An op's `model` param overrides both: it names a graph when
it matches one of these directory names, otherwise it is substituted into the graph's own
loader widget.

## Substituted node ids

| Graph | image | mask | prompt | seed | strength | model | output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inpaint-flux-fill` | `160.image` | `211.image` | `108.text` | `112.seed` | — | `106.unet_name` | `313` |
| `inpaint-sdxl` | `156.image` | `207.image` | `102.text` | `105.seed` | — | `101.ckpt_name` | `309` |
| `remove` | `156.image` | `207.image` | — | `105.seed` | — | `101.ckpt_name` | `309` |
| `denoise` | `156.image` | — | — | `105.seed` | `105.denoise` | `101.ckpt_name` | `207` |
| `upscale` | `152.image` | — | — | — | — | `101.model_name` | `203` |

`remove` has no prompt binding on purpose: the op has no prompt param, and the graph's own
positive and negative text are what "remove" means. The two whole-frame graphs have no mask
binding for the same reason — there is no mask to bind, and the backend skips the upload.
`output` is the `SaveImage` node, read back from the run envelope's `outputs_by_node`.

The node ids are minted by `comfy workflow compose` and are stable for a given compiled
file. They change if the graph is recomposed — update `bindings.json` and this table
together, and `engine/tests/generative_test.cpp` will catch a binding that no longer
resolves.
