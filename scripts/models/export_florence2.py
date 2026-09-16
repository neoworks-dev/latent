"""Export microsoft/Florence-2 to ONNX graphs the C++ engine can run.

Split (mirrors what transformers.js uses, so the layout is not exotic):

  vision_encoder.onnx  pixel_values [1,3,768,768] -> image_features [1,577,768]
  embed_tokens.onnx    input_ids    [B,L] i64     -> inputs_embeds  [B,L,768]
  encoder_model.onnx   inputs_embeds + attention_mask -> encoder_hidden_states
  decoder_model.onnx   decoder_input_ids + encoder_hidden_states -> logits

The decoder is stateless on purpose: the detection tasks emit at most ~40 tokens
and a 6-layer/768-wide BART decoder re-runs in single-digit milliseconds, which
buys the C++ port freedom from carrying 24 KV tensors between calls. Pass
--with-cache to additionally emit decoder_with_past_model.onnx.

The HF repo `microsoft/Florence-2-base` still ships the remote-code layout whose
tokenizer trips transformers 5 ("RobertaTokenizer has no attribute image_token").
The converted mirror `florence-community/Florence-2-base` is the same weights in
the native `Florence2ForConditionalGeneration` layout, so that is the source.
"""

from __future__ import annotations

import argparse
import datetime
import shutil
from pathlib import Path

import torch
from torch import nn

from common import MODEL_STORE, write_json

REPOS = {
    "base": "florence-community/Florence-2-base",
    "large": "florence-community/Florence-2-large",
}
# Files the C++ side needs to build input_ids and to turn generated ids back into text.
TOKENIZER_FILES = [
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
    "added_tokens.json",
    "preprocessor_config.json",
]


class VisionEncoder(nn.Module):
    """DaViT backbone + multimodal projector -> the 577 image tokens."""

    def __init__(self, model) -> None:
        super().__init__()
        self.vision_tower = model.model.vision_tower
        self.projector = model.model.multi_modal_projector

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        features = self.vision_tower(pixel_values).last_hidden_state
        return self.projector(features)


class EmbedTokens(nn.Module):
    def __init__(self, model) -> None:
        super().__init__()
        self.embed = model.model.get_input_embeddings()

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.embed(input_ids)


class TextEncoder(nn.Module):
    def __init__(self, model) -> None:
        super().__init__()
        self.encoder = model.model.language_model.encoder

    def forward(self, inputs_embeds: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        return self.encoder(
            inputs_embeds=inputs_embeds, attention_mask=attention_mask
        ).last_hidden_state


class Decoder(nn.Module):
    """Stateless decoder: full prefix in, logits for the whole prefix out."""

    def __init__(self, model) -> None:
        super().__init__()
        self.decoder = model.model.language_model.decoder
        self.lm_head = model.lm_head

    def forward(
        self,
        decoder_input_ids: torch.Tensor,
        encoder_hidden_states: torch.Tensor,
        encoder_attention_mask: torch.Tensor,
    ) -> torch.Tensor:
        hidden = self.decoder(
            input_ids=decoder_input_ids,
            encoder_hidden_states=encoder_hidden_states,
            encoder_attention_mask=encoder_attention_mask,
            use_cache=False,
        ).last_hidden_state
        return self.lm_head(hidden)


def export_one(module: nn.Module, args: tuple, path: Path, names: dict, dynamic: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  exporting {path.name} ...", flush=True)
    torch.onnx.export(
        module,
        args,
        str(path),
        input_names=names["inputs"],
        output_names=names["outputs"],
        dynamic_axes=dynamic,
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )


def export(size: str, out_dir: Path) -> Path:
    from transformers import Florence2ForConditionalGeneration, Florence2Processor

    repo = REPOS[size]
    processor = Florence2Processor.from_pretrained(repo)
    model = Florence2ForConditionalGeneration.from_pretrained(
        repo, dtype=torch.float32, attn_implementation="eager"
    ).eval()
    text_config = model.config.text_config
    image_size = processor.image_processor.size["height"]
    # 577 = 576 spatial (24x24 patches at stride 32) + 1 temporal token.
    image_tokens = processor.num_image_tokens

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(exist_ok=True)

    with torch.no_grad():
        export_one(
            VisionEncoder(model),
            (torch.zeros(1, 3, image_size, image_size),),
            onnx_dir / "vision_encoder.onnx",
            {"inputs": ["pixel_values"], "outputs": ["image_features"]},
            {"pixel_values": {0: "batch"}, "image_features": {0: "batch"}},
        )
        export_one(
            EmbedTokens(model),
            (torch.zeros(1, 8, dtype=torch.long),),
            onnx_dir / "embed_tokens.onnx",
            {"inputs": ["input_ids"], "outputs": ["inputs_embeds"]},
            {
                "input_ids": {0: "batch", 1: "sequence"},
                "inputs_embeds": {0: "batch", 1: "sequence"},
            },
        )
        prefix = image_tokens + 12
        export_one(
            TextEncoder(model),
            (
                torch.zeros(1, prefix, text_config.hidden_size),
                torch.ones(1, prefix, dtype=torch.long),
            ),
            onnx_dir / "encoder_model.onnx",
            {
                "inputs": ["inputs_embeds", "attention_mask"],
                "outputs": ["encoder_hidden_states"],
            },
            {
                "inputs_embeds": {0: "batch", 1: "sequence"},
                "attention_mask": {0: "batch", 1: "sequence"},
                "encoder_hidden_states": {0: "batch", 1: "sequence"},
            },
        )
        export_one(
            Decoder(model),
            (
                torch.zeros(1, 4, dtype=torch.long),
                torch.zeros(1, prefix, text_config.hidden_size),
                torch.ones(1, prefix, dtype=torch.long),
            ),
            onnx_dir / "decoder_model.onnx",
            {
                "inputs": ["decoder_input_ids", "encoder_hidden_states", "encoder_attention_mask"],
                "outputs": ["logits"],
            },
            {
                "decoder_input_ids": {0: "batch", 1: "decoder_sequence"},
                "encoder_hidden_states": {0: "batch", 1: "sequence"},
                "encoder_attention_mask": {0: "batch", 1: "sequence"},
                "logits": {0: "batch", 1: "decoder_sequence"},
            },
        )

    for name in TOKENIZER_FILES:
        try:
            source = Path(
                __import__("huggingface_hub").hf_hub_download(repo_id=repo, filename=name)
            )
        except Exception:
            continue
        shutil.copyfile(source, out_dir / name)

    write_json(
        out_dir / "config.json",
        {
            "model_name": f"florence-2-{size}",
            "checkpoint_id": repo,
            "upstream_id": f"microsoft/Florence-2-{size}",
            "version": "2.0",
            "vision_encoder_path": "onnx/vision_encoder.onnx",
            "embed_tokens_path": "onnx/embed_tokens.onnx",
            "encoder_path": "onnx/encoder_model.onnx",
            "decoder_path": "onnx/decoder_model.onnx",
            "image_size": image_size,
            "image_tokens": image_tokens,
            "hidden_size": text_config.hidden_size,
            "vocab_size": text_config.vocab_size,
            "decoder_layers": text_config.decoder_layers,
            "image_token_id": model.config.image_token_id,
            "bos_token_id": text_config.bos_token_id,
            "eos_token_id": text_config.eos_token_id,
            "pad_token_id": text_config.pad_token_id,
            "decoder_start_token_id": text_config.decoder_start_token_id,
            "image_mean": processor.image_processor.image_mean,
            "image_std": processor.image_processor.image_std,
            "quantize_bins": 1000,
            "conversion_date": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )
    return out_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=sorted(REPOS), default="base")
    parser.add_argument("--out", type=Path, default=None)
    arguments = parser.parse_args()
    out = arguments.out or MODEL_STORE / f"florence-2-{arguments.size}"
    print(f"exporting Florence-2-{arguments.size} into {out}")
    export(arguments.size, out)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
