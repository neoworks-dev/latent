# AI mask models

Everything Phase 1 masking needs, prepared and measured on this machine
(RTX 4080 SUPER 16 GB, CUDA 13.3, cuDNN 9.26, onnxruntime 1.30.0 cuda13 — the same
build `engine/cmake/onnxruntime.cmake` pins).

The Python here is a **reference implementation, not a runtime**. It exists so the
C++ port has numbers to diff against. The engine loads the same ONNX graphs with
the C++ ORT API.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python numpy pillow rawpy requests onnx onnxruntime-gpu==1.30.0 \
    torch torchvision --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python transformers timm einops kornia huggingface_hub

LD_LIBRARY_PATH=/opt/cuda/lib64 .venv/bin/python fetch.py --verify
```

`LD_LIBRARY_PATH=/opt/cuda/lib64` is needed because the `onnxruntime-gpu` wheel expects
the CUDA 13 runtime from the system (pacman `cuda`, `cudnn`), not a pip-vendored one.
Torch is CPU-only on purpose: it is used for exporting, never for inference, and the
`cu130` wheels pull ~4 GB of `pypi.nvidia.com` packages that time out here.

## Store layout

`~/.local/share/latent/models` (override with `LATENT_MODEL_STORE`). `manifest.json`
at the top carries sha256 + size of every file.

| Model                   | Size          | Role                          | Mask kinds                                        |
| ----------------------- | ------------- | ----------------------------- | ------------------------------------------------- |
| `sam2-hiera-base-plus/` | 360.4 MB      | box or points -> mask         | `objects`, `text`, and the SAM half of any prompt |
| `florence-2-base/`      | 1248.3 MB     | text -> box                   | `text`                                            |
| `birefnet-lite/`        | 114.5 MB      | salient-object alpha matte    | `subject`, `background`                           |
| `segformer-b2-ade20k/`  | 110.4 MB      | 150-class ADE20K semantic map | `sky`, `people`                                   |
|                         | **1833.6 MB** |                               |                                                   |

```
sam2-hiera-base-plus/   config.json encoder.onnx decoder.onnx
florence-2-base/        config.json tokenizer.json tokenizer_config.json vocab.json
                        merges.txt added_tokens.json special_tokens_map.json
                        preprocessor_config.json
                        onnx/{vision_encoder,embed_tokens,encoder_model,decoder_model}.onnx
birefnet-lite/          config.json model.onnx
segformer-b2-ade20k/    config.json labels.json model.onnx
```

## SAM 2 — hiera-base-plus

Exported with `samexporter` from `facebook/sam2-hiera-base-plus` (2.0). `fetch.py`
will not regenerate it; it prints the samexporter command if the files are gone.

### encoder.onnx (339.8 MB)

| Dir | Name               | Type    | Shape                |
| --- | ------------------ | ------- | -------------------- |
| in  | `image`            | float32 | `[1, 3, 1024, 1024]` |
| out | `high_res_feats_0` | float32 | `[1, 32, 256, 256]`  |
| out | `high_res_feats_1` | float32 | `[1, 64, 128, 128]`  |
| out | `image_embed`      | float32 | `[1, 256, 64, 64]`   |

Shapes are fully static. opset 18, IR 8.

### decoder.onnx (20.6 MB)

| Dir | Name               | Type    | Shape                         |
| --- | ------------------ | ------- | ----------------------------- |
| in  | `image_embed`      | float32 | `[1, 256, 64, 64]`            |
| in  | `high_res_feats_0` | float32 | `[1, 32, 256, 256]`           |
| in  | `high_res_feats_1` | float32 | `[1, 64, 128, 128]`           |
| in  | `point_coords`     | float32 | `[num_labels, num_points, 2]` |
| in  | `point_labels`     | float32 | `[num_labels, num_points]`    |
| in  | `mask_input`       | float32 | `[num_labels, 1, 256, 256]`   |
| in  | `has_mask_input`   | float32 | `[num_labels]`                |
| out | `masks`            | float32 | `[num_labels, 3, 256, 256]`   |
| out | `iou_predictions`  | float32 | `[num_labels, 3]`             |

**`num_labels` must be 1.** The graph does
`dense = has_mask_input * conv(mask_input) + (1 - has_mask_input) * no_mask_embed`
with `has_mask_input` at rank 1, so for N > 1 ONNX broadcasting fails at node
`/Mul_14` ("left operand cannot broadcast on dim 0 LeftShape: {3}, RightShape:
{3,256,64,64}"), and feeding it as `[N,1,1,1]` is rejected ("Invalid rank for input:
has_mask_input Got: 4 Expected: 1"). Multi-object prompts are a loop over single
decoder calls — 6.4 ms each, so a 20-person mask is ~130 ms.

### Preprocessing

The probe's "input image is not float32" was wrong — see _Gotchas_. It is float32.

1. Resize RGB to exactly 1024x1024, **bilinear, no letterbox**. SAM 2 squashes the
   aspect ratio (`SAM2Transforms` is `Resize((1024, 1024))`, unlike SAM 1's
   longest-side + pad). Aspect is restored by scaling prompts and the output mask.
2. `/ 255`, then ImageNet normalise: mean `(0.485, 0.456, 0.406)`, std
   `(0.229, 0.224, 0.225)`, per channel, RGB order.
3. Transpose to NCHW, contiguous float32.

There is no normalisation node in the graph — the first op is
`patch_embed/proj/Conv` straight off `image` — so all of the above is the caller's job.

### Prompts

Coordinates are in **encoder input space**: `x * 1024 / original_width`,
`y * 1024 / original_height`. Labels:

| Label | Meaning                 |
| ----- | ----------------------- |
| `1`   | foreground point        |
| `0`   | background point        |
| `2`   | box top-left corner     |
| `3`   | box bottom-right corner |
| `-1`  | padding                 |

A box is those two corner points in one prompt row. Box and extra points can be
concatenated in the same row. With no mask refinement pass `mask_input` is zeros
`[1,1,256,256]` and `has_mask_input` is `[0.0]`; to refine, feed back the chosen
`masks[0, best]` plane (the raw 256x256 logits, **not** the thresholded mask) with
`has_mask_input = [1.0]`.

### Output

`masks` are logits at 256x256, three candidates, clipped to +/-32 by the graph. Pick
`argmax(iou_predictions[0])`, bilinear-resize that plane to the image size
(`align_corners=False`), threshold at `> 0`. Do not resize the thresholded mask — the
soft logits carry the sub-pixel edge and give the mask something to feather from.

## Florence-2 — base

Exported here by `export_florence2.py` from `florence-community/Florence-2-base`.
`microsoft/Florence-2-base` still ships the remote-code layout, whose tokenizer fails
under transformers 5 with `RobertaTokenizer has no attribute image_token`; the
`florence-community` mirror is the same weights in the native
`Florence2ForConditionalGeneration` layout.

Base was enough — it put "the person" and "the hat" on the sample raw within a couple
of `<loc_>` bins of what large-scale evaluation would want, and its failures (see
_Quality_) are not the kind `-large` fixes.

### Graphs

| Graph                 | Size     | in                                                                                                                   | out                                       |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `vision_encoder.onnx` | 366.3 MB | `pixel_values` f32 `[b,3,768,768]`                                                                                   | `image_features` f32 `[b,577,768]`        |
| `embed_tokens.onnx`   | 157.7 MB | `input_ids` i64 `[b,seq]`                                                                                            | `inputs_embeds` f32 `[b,seq,768]`         |
| `encoder_model.onnx`  | 173.4 MB | `inputs_embeds` f32 `[b,seq,768]`, `attention_mask` i64 `[b,seq]`                                                    | `encoder_hidden_states` f32 `[b,seq,768]` |
| `decoder_model.onnx`  | 545.5 MB | `decoder_input_ids` i64 `[b,dec]`, `encoder_hidden_states` f32 `[b,seq,768]`, `encoder_attention_mask` i64 `[b,seq]` | `logits` f32 `[b,dec,51328]`              |

**The decoder is stateless — no KV cache, by decision.** A full re-run of the 6-layer
decoder costs 2.7 ms per token and detection answers are 8-12 tokens, so the whole
greedy loop is 21 ms. A merged-cache export would save maybe 15 ms and would make the
C++ side carry 24 KV tensors across calls. Revisit only if captioning tasks (100+
tokens) get wired up.

`embed_tokens` and `decoder_model` each carry their own copy of the 51328x768
embedding table (157 MB) — that is why the four graphs total 1.25 GB for a 230 M
parameter model. fp16 would halve it.

### Preprocessing

`preprocessor_config.json`: resize to exactly 768x768, `resample: 3` = **bicubic**,
`do_center_crop: false` (so aspect is squashed, like SAM 2), `/255`, ImageNet mean/std.

### Prompt construction

Task tokens are never fed to the model. The processor swaps each for a sentence:

| Task token                            | Sentence sent to the model                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| `<OPEN_VOCABULARY_DETECTION>`         | `Locate {input} in the image.`                              |
| `<CAPTION_TO_PHRASE_GROUNDING>`       | `Locate the phrases in the caption: {input}`                |
| `<REFERRING_EXPRESSION_SEGMENTATION>` | `Locate {input} in the image with mask`                     |
| `<OD>`                                | `Locate the objects with category name in the image.`       |
| `<DENSE_REGION_CAPTION>`              | `Locate the objects in the image, with their descriptions.` |
| `<REGION_PROPOSAL>`                   | `Locate the region proposals in the image.`                 |
| `<CAPTION>`                           | `What does the image describe?`                             |
| `<DETAILED_CAPTION>`                  | `Describe in detail what is shown in the image.`            |
| `<MORE_DETAILED_CAPTION>`             | `Describe with a paragraph what is shown in the image.`     |
| `<OCR>`                               | `What is the text in the image?`                            |
| `<OCR_WITH_REGION>`                   | `What is the text in the image, with regions?`              |

Then:

1. `input_ids = [51289] * 577 + [0] + tokenizer(sentence) + [2]` — 577 image
   placeholders (`<image>`, id 51289), then BOS (0), the prompt with **no** special
   tokens added by the tokenizer, then EOS (2).
2. Run `embed_tokens` on that.
3. Overwrite rows `[0, 577)` of `inputs_embeds` with `image_features` from the vision
   encoder. (transformers does a `masked_scatter` on `input_ids == 51289`; a slice
   assignment is equivalent because the placeholders are contiguous and first.)
4. `attention_mask` is all ones, length 577 + 2 + prompt tokens.

577 = 576 spatial tokens (24x24 patches at stride 32 over 768 px) + 1 temporal token.

### Greedy decode

Start `decoder_input_ids = [2]` (`decoder_start_token_id`, which is EOS for this BART
config — the raw output really does begin `</s><s>`). Each step: run the decoder over
the whole prefix, take `argmax(logits[0, -1])`, append, stop on EOS (id 2) after at
least two tokens, cap at 128. Tokenizer files ship next to the graphs; decode with
`skip_special_tokens=False` so `<loc_###>` survives.

### Box de-quantisation

Generated text looks like `</s><s>the person<loc_401><loc_232><loc_741><loc_854></s>`.
Parse `(label)((?:<loc_\d+>){4})` repeatedly; an empty label means "same label as the
previous group" (that is how `<OD>` emits two boxes for one `footwear`). 1000 bins per
axis, bin centre, truncate:

```
x = int((bin + 0.5) * width  / 1000)
y = int((bin + 0.5) * height / 1000)
```

Box coordinates come out in the **original image's** pixel space, so they feed SAM 2
directly.

## BiRefNet-lite — `subject` / `background`

MIT, 44 M params, `ZhengPeng7/BiRefNet_lite`. **Not exported from torch here**:
its decoder uses `torchvision::deform_conv2d`, which has no ONNX operator, and
`torch.onnx.export` stops with `UnsupportedOperatorError`. `fetch.py` copies
`onnx-community/BiRefNet_lite/onnx/model_fp16.onnx` (a decomposed export of the same
weights) into the store.

| Dir | Name           | Type    | Shape                |
| --- | -------------- | ------- | -------------------- |
| in  | `input_image`  | float32 | `[1, 3, 1024, 1024]` |
| out | `output_image` | float32 | `[1, 1, 1024, 1024]` |

Weights are fp16 inside; the interface stays float32. Preprocess exactly like SAM 2
(bilinear squash to 1024, /255, ImageNet mean/std). **The output is raw logits, not a
probability** — apply sigmoid, then bilinear-resize to the image. `subject` is
`alpha > 0.5`; `background` is `1 - alpha`, which is a better background mask than
inverting a hard mask because the matte keeps hair and fur soft.

## SegFormer-B2 ADE20K — `sky` / `people`

`nvidia/segformer-b2-finetuned-ade-512-512`, 27 M params, exported here.
Licence is the NVIDIA Source Code License-NC — fine for a personal tool, a blocker if
Latent is ever sold.

| Dir | Name           | Type    | Shape                |
| --- | -------------- | ------- | -------------------- |
| in  | `pixel_values` | float32 | `[b, 3, 512, 512]`   |
| out | `logits`       | float32 | `[b, 150, 128, 128]` |

Resize to 512x512 (bilinear squash), /255, ImageNet mean/std. Class 2 is `sky`,
class 12 is `person`; `labels.json` has all 150.

Upsample **before** argmax, not after, or edges quantise to the 128x128 grid. For a
single class that is two resizes, not 150: take `L[c]` and `max(L[k != c])`, resize
both, compare. Agreed with the full 150-plane path to within 0.04 % coverage on all
test images.

## Timings — CUDA EP, p50 of 10 after warm-up

Sample raw `~/Downloads/DSC00120.ARW` decoded to 1026x1536 (rawpy, `half_size=True`,
camera WB — not the embedded JPEG). Session load and VRAM measured with the model
alone in the process.

| Stage                                         | p50      | p90      | Session load        | VRAM after load | VRAM peak |
| --------------------------------------------- | -------- | -------- | ------------------- | --------------- | --------- |
| SAM 2 encoder 1024x1024                       | 102.4 ms | 103.6 ms | 458 ms              | 654 MB          | 2560 MB   |
| SAM 2 decoder, 1 box                          | 6.4 ms   | 6.9 ms   | (same session pair) |                 |           |
| Florence-2 vision 768x768                     | 48.3 ms  | 48.8 ms  | 1562 ms             | 1654 MB         | 2088 MB   |
| Florence-2 encoder + greedy decode (9 tokens) | 21.2 ms  | 21.5 ms  |                     |                 |           |
| — of which text encoder                       | 3.2 ms   | 4.0 ms   |                     |                 |           |
| — of which per decode step                    | 2.7 ms   |          |                     |                 |           |
| BiRefNet-lite 1024x1024                       | 201.1 ms | 214.3 ms | 1130 ms             | 546 MB          | 6214 MB   |
| SegFormer-B2 512x512                          | 21.4 ms  | 22.1 ms  | 194 ms              | 368 MB          | 868 MB    |

End to end: text prompt -> mask is **Florence 70 ms + SAM 2 encode 102 ms + decode
6 ms ≈ 180 ms**, plus ~2 s of session load on the first call. `subject` is 200 ms,
`sky`/`people` are 21 ms. All are jobs, none are in a slider tick.

## Quality — is Florence-2 -> SAM 2 enough?

Three CC0 photos (`testdata.py`, from Openverse): a crowded Santiago street, a
harvested field under a big sky, a dog in grass. Contact sheets:
`/tmp/latent-eval-{street,landscape,pet}.png`, `/tmp/latent-eval-segformer.png`,
`/tmp/latent-eval-birefnet.png`. Re-run with `evaluate.py`.

**subject.** Not good enough — use BiRefNet-lite. Florence's "the main subject" box
degenerates to a big rectangle whenever no single object dominates, and SAM 2 then
faithfully segments whatever fills that rectangle: on the landscape it returned the
entire wheat field (36 % coverage) instead of the harrow sitting in it, and on the
street it returned the pavement (24 %) instead of any pedestrian. BiRefNet-lite got
the harrow, the dog with fur detail, the woman in the studio shot, and a plausible set
of foreground pedestrians — the same answers Lightroom's Select Subject gives, at
201 ms and 114 MB. Recommendation: wire `subject` and `background` to BiRefNet-lite;
keep the matte as the mask (it is already soft) rather than thresholding it.

**sky.** Not good enough — use SegFormer-ADE20K. Florence-2 never abstains, so on the
studio raw it answered "sky" with `<loc_0><loc_0><loc_998><loc_677>` and SAM 2 dutifully
selected 57 % of the frame: the seamless paper backdrop. It also under-covers real
skies seen through gaps (the street scene got one box on the left half, 5.7 % instead
of the full skyline). SegFormer-B2 returned **0.0000** sky on the studio raw, 57.0 % on
the landscape with a clean horizon including power lines, and the exact sky gap on the
street — at 21 ms, a tenth of the cost. Recommendation: `sky` is SegFormer class 2, and
the empty result is a feature, not a failure to report.

**background.** Only ever as good as `subject`, so it inherits the same verdict:
`background = 1 - BiRefNet alpha`. Worth noting the two are not interchangeable in the
UI — `background` on the street scene is a much more useful mask than `NOT subject`
computed from a Florence box, which was just "the top half of the image".

**people.** Not good enough — use SegFormer-ADE20K class 12. `<OD>` is the only
Florence task that returns every instance, and it saturates at about 30 detections
that it spends on the wrong things: on the crowd it emitted 24 `footwear` boxes, 3
`man`, 3 `building`, and covered 5.2 % of the frame. `<CAPTION_TO_PHRASE_GROUNDING>`
with "people" returned one box around the whole crowd, which SAM 2 turned into the
pavement. SegFormer covered 39.1 % — visibly every pedestrian including the motion-
blurred ones. Its one failure is a false positive: it labels ~7.5 % of the dog photo
`person` (the dog's head and chest). For per-person masks (Lightroom's "People" panel
lists individuals) SegFormer's semantic map is not enough on its own — pair it with
SAM 2 by sampling foreground points inside each connected component, or add a
detection model later.

**text.** Florence-2 -> SAM 2 is exactly right for this one and should stay. "the
person", "the hat", "the dog" all produced tight, correct boxes and clean masks.

## C++ port notes

- **Tensor layout is NCHW float32 everywhere**, contiguous, and every graph except
  Florence-2's takes fixed spatial dims. Only Florence-2 has dynamic axes (batch,
  sequence, decoder sequence).
- **Session options** used here, mirroring what the engine should set:
  `GraphOptimizationLevel::ORT_ENABLE_ALL`, CUDA EP with `device_id = 0`,
  `arena_extend_strategy = kSameAsRequested`, `cudnn_conv_algo_search = EXHAUSTIVE`,
  `do_copy_in_default_stream = true`, CPU EP as fallback. The `EXHAUSTIVE` search is
  what makes SAM 2's first encoder run ~450 ms and every later one ~100 ms.
- **VRAM is the real constraint, not disk.** All four sessions resident plus
  BiRefNet's 822 MB transient exhausted 16 GB during development
  (`BFCArena ... Failed to allocate memory for requested buffer of size 822083584`).
  Load one mask model per job and drop the session; only SAM 2 is worth keeping warm,
  because its encoder output is reused for every prompt on the same photo. With
  ComfyUI next door holding 12 GB, nothing here fits — mask jobs and generative jobs
  must not overlap.
- **Cache the SAM 2 encoder output per photo**, keyed on the proxy hash. It costs
  100 ms and 16.8 MB of float32 (`image_embed` 4.2, `high_res_feats_0` 8.4,
  `high_res_feats_1` 4.2); every extra prompt on that photo is then 6 ms.
- **Resampling convention.** Every resize in this pipeline is bilinear with
  `align_corners=False` — output centre maps to `(x + 0.5) * in/out - 0.5`. PIL's
  BILINEAR on an `F` image agrees with `torch.nn.functional.interpolate` to 1.3e-5
  here; `align_corners=True` would shift masks half a source pixel at the edges.
- **Thresholds happen last.** Resize logits, then threshold. The engine wants the soft
  plane anyway for feathering.
- **`Ort::TypeInfo` lifetime** — see below. It is the one thing in this whole exercise
  that silently produced a wrong answer instead of an error.
- **Reference tensors** are in `/tmp/latent-ref-tensors/` (`segment.py --dump-tensors`):
  preprocessed input, all three encoder outputs, low-res logits, IoU, final mask, plus a
  `.json` with the box and coverage. Diff stage by stage; the encoder outputs are the
  first place a preprocessing mistake shows up.

## Gotchas

- **`probe_onnx` reports "input image is not float32" for a float32 model.** It is a
  use-after-free, not a model property. `session.GetInputTypeInfo(i)` returns an owning
  `Ort::TypeInfo` temporary; `.GetTensorTypeAndShapeInfo()` returns a non-owning view
  into it, so `auto info = session.GetInputTypeInfo(i).GetTensorTypeAndShapeInfo();`
  reads freed memory. Verified against the SAM 2 encoder:

  ```
  dangling element type = -1369932770
  live     element type = 1 (1 == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
  ```

  Keep the `Ort::TypeInfo` in a named local for as long as the shape info is used.

- **SAM 2's decoder cannot batch prompts** (`num_labels` must be 1) — see above.
- **BiRefNet's ONNX output is logits, not alpha.** Nothing errors if you skip the
  sigmoid; the mask just gets slightly bigger, which is the worst kind of bug.
- **Florence-2 never abstains.** Every task returns something. `sky` on an indoor photo
  returns a box. Any mask kind built on it needs its own sanity check, which is most of
  why `sky`/`subject`/`people` moved to dedicated models.
- **ORT 1.30 logs `No registered plugin EP device found for 'CUDAExecutionProvider'`**
  at every session creation. It refers to the new plugin-EP mechanism; the classic CUDA
  EP still registers and runs. Harmless noise.
- **`ScatterND with reduction=='none' only guarantees to be correct if indices are not
duplicated`** comes from SAM 2's decoder. Also harmless — the indices are the prompt
  points, and duplicates would only matter if two prompts landed on the same pixel.

## Files

| File                  | What                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `fetch.py`            | idempotent install of all four models, `manifest.json`, `--verify` |
| `segment.py`          | reference pipeline: `--prompt` / `--box` / `--points` / `--kind`   |
| `evaluate.py`         | contact sheets for the quality assessment                          |
| `sam2.py`             | SAM 2 preprocessing, prompts, decode, upsample                     |
| `florence2.py`        | task tokens, prompt build, greedy decode, box parsing              |
| `dedicated.py`        | BiRefNet-lite and SegFormer-ADE20K runtimes                        |
| `export_florence2.py` | torch -> ONNX for Florence-2                                       |
| `export_dedicated.py` | torch -> ONNX for SegFormer, fetch for BiRefNet                    |
| `common.py`           | store paths, sha256, raw decode, resize convention, timers         |
| `testdata.py`         | the three CC0 evaluation photos                                    |
| `inspect_onnx.py`     | print a graph's inputs and outputs                                 |
