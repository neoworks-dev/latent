"""Florence-2 ONNX runtime: text prompt -> boxes + labels.

Four sessions, one greedy decode loop, one regex. Everything the C++ port has to
reimplement is in this file and nothing else.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from common import MODEL_STORE, cuda_providers, read_json

# Task tokens are never sent to the model. The processor swaps each one for a
# plain-English sentence; these are the exact strings (transformers 5.17
# processing_florence2.py, identical to the original remote code).
TASK_PROMPTS = {
    "<CAPTION>": "What does the image describe?",
    "<DETAILED_CAPTION>": "Describe in detail what is shown in the image.",
    "<MORE_DETAILED_CAPTION>": "Describe with a paragraph what is shown in the image.",
    "<OD>": "Locate the objects with category name in the image.",
    "<DENSE_REGION_CAPTION>": "Locate the objects in the image, with their descriptions.",
    "<REGION_PROPOSAL>": "Locate the region proposals in the image.",
    "<OCR>": "What is the text in the image?",
    "<OCR_WITH_REGION>": "What is the text in the image, with regions?",
}
TASK_PROMPTS_WITH_INPUT = {
    "<CAPTION_TO_PHRASE_GROUNDING>": "Locate the phrases in the caption: {input}",
    "<OPEN_VOCABULARY_DETECTION>": "Locate {input} in the image.",
    "<REFERRING_EXPRESSION_SEGMENTATION>": "Locate {input} in the image with mask",
}

BOX_PATTERN = re.compile(r"([^<]*)((?:<loc_\d+>){4})")
LOC_PATTERN = re.compile(r"<loc_(\d+)>")


def build_prompt(task: str, text: str = "") -> str:
    if task in TASK_PROMPTS_WITH_INPUT:
        return TASK_PROMPTS_WITH_INPUT[task].format(input=text.strip())
    if task in TASK_PROMPTS:
        return TASK_PROMPTS[task]
    raise ValueError(f"unknown task token {task}")


def preprocess(image: np.ndarray, image_size: int, mean, std) -> np.ndarray:
    """RGB uint8 HWC -> float32 NCHW. Bicubic squash to 768x768, ImageNet norm.

    `resample: 3` in preprocessor_config.json is PIL.Image.BICUBIC, and
    do_center_crop is false, so the aspect ratio is not preserved.
    """
    resized = Image.fromarray(image).resize((image_size, image_size), Image.BICUBIC)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - np.asarray(mean, np.float32)) / np.asarray(std, np.float32)
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


def dequantize_box(bins: list[int], width: int, height: int) -> list[int]:
    """<loc_n> bins -> pixels. Bin centre, then truncate: (n + 0.5) * size / 1000."""
    per_bin_w = width / 1000.0
    per_bin_h = height / 1000.0
    x0, y0, x1, y1 = bins
    return [
        int((x0 + 0.5) * per_bin_w),
        int((y0 + 0.5) * per_bin_h),
        int((x1 + 0.5) * per_bin_w),
        int((y1 + 0.5) * per_bin_h),
    ]


def parse_boxes(text: str, width: int, height: int) -> list[dict]:
    """Every '<label><loc><loc><loc><loc>' group in the generated string."""
    cleaned = text.replace("<s>", "").replace("</s>", "").replace("<pad>", "")
    results = []
    label = ""
    for match in BOX_PATTERN.finditer(cleaned):
        phrase = match.group(1).strip()
        if phrase:
            label = phrase
        bins = [int(value) for value in LOC_PATTERN.findall(match.group(2))]
        results.append({"label": label, "box": dequantize_box(bins, width, height)})
    return results


class Florence2:
    def __init__(self, model_dir: Path | None = None, providers=None, size: str = "base") -> None:
        from tokenizers import Tokenizer

        self.dir = Path(model_dir or MODEL_STORE / f"florence-2-{size}")
        self.config = read_json(self.dir / "config.json")
        self.tokenizer = Tokenizer.from_file(str(self.dir / "tokenizer.json"))

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.log_severity_level = 3
        providers = providers or cuda_providers()

        def session(key: str) -> ort.InferenceSession:
            return ort.InferenceSession(str(self.dir / self.config[key]), options, providers=providers)

        self.vision = session("vision_encoder_path")
        self.embed = session("embed_tokens_path")
        self.encoder = session("encoder_path")
        self.decoder = session("decoder_path")

    def encode_image(self, image: np.ndarray) -> np.ndarray:
        tensor = preprocess(
            image, self.config["image_size"], self.config["image_mean"], self.config["image_std"]
        )
        return self.vision.run(["image_features"], {"pixel_values": tensor})[0]

    def build_inputs(self, prompt: str, image_features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Image tokens first, then <s> prompt </s>; image slots get the vision embeds."""
        text_ids = self.tokenizer.encode(prompt, add_special_tokens=False).ids
        bos, eos = self.config["bos_token_id"], self.config["eos_token_id"]
        image_count = image_features.shape[1]
        ids = np.array(
            [[self.config["image_token_id"]] * image_count + [bos] + text_ids + [eos]],
            dtype=np.int64,
        )
        embeds = self.embed.run(["inputs_embeds"], {"input_ids": ids})[0]
        embeds[:, :image_count, :] = image_features
        return embeds, np.ones((1, ids.shape[1]), dtype=np.int64)

    def generate(self, embeds: np.ndarray, attention_mask: np.ndarray, max_new_tokens: int = 128):
        hidden = self.encoder.run(
            ["encoder_hidden_states"],
            {"inputs_embeds": embeds, "attention_mask": attention_mask},
        )[0]
        eos = self.config["eos_token_id"]
        tokens = [self.config["decoder_start_token_id"]]
        for _ in range(max_new_tokens):
            logits = self.decoder.run(
                ["logits"],
                {
                    "decoder_input_ids": np.array([tokens], dtype=np.int64),
                    "encoder_hidden_states": hidden,
                    "encoder_attention_mask": attention_mask,
                },
            )[0]
            token = int(np.argmax(logits[0, -1]))
            tokens.append(token)
            if token == eos and len(tokens) > 2:
                break
        return tokens

    def run(self, image: np.ndarray, task: str, text: str = "", max_new_tokens: int = 128) -> dict:
        height, width = image.shape[:2]
        features = self.encode_image(image)
        embeds, mask = self.build_inputs(build_prompt(task, text), features)
        tokens = self.generate(embeds, mask, max_new_tokens)
        raw = self.tokenizer.decode(tokens, skip_special_tokens=False)
        return {"raw": raw, "tokens": tokens, "detections": parse_boxes(raw, width, height)}

    def detect(self, image: np.ndarray, phrase: str) -> list[dict]:
        """Open-vocabulary detection; falls back to phrase grounding when empty."""
        result = self.run(image, "<OPEN_VOCABULARY_DETECTION>", phrase)
        if result["detections"]:
            return result["detections"]
        return self.run(image, "<CAPTION_TO_PHRASE_GROUNDING>", phrase)["detections"]
