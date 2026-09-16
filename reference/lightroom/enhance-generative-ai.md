# Enhance with AI (Generative Upscale / AI Sharpen)

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/enhance-images-with-generative-ai.html (fetched 2026-09-16)

Accessed via right-click > Enhance with AI, or Photo > Enhance with AI. Both features are Topaz-powered and consume generative credits based on output file size; each produces a new file (optionally grouped into a stack).

## Generative Upscale

| Control | Range | Description |
|---|---|---|
| Output scale | 2x / 4x | Increases image resolution while analyzing the photo to enhance detail and preserve quality |
| Create stack | on/off | Groups the upscaled and original photos together (Cloud only) |

Credits: Topaz Gigapixel — 10 credits (files up to 25 MP), 20 credits (25–56 MP). If the chosen scale exceeds a model's limit, reduce the scale or resize the image first.

## AI Sharpen

| Control | Range | Description |
|---|---|---|
| Strength | Default / Strong | Default = balanced sharpening; Strong = higher intensity for recovering clarity in blurred images |
| Apply Topaz Denoise | on/off | Reduces noise while recovering detail in low-light photos, applied alongside sharpening |
| Create stack | on/off | Groups the sharpened and original photos together (Cloud only) |

Credits: Topaz Sharpen — 10 credits (files up to 25 MP), 20 credits (25–56 MP).

## Interactions

- Distinct from `enhance-details.md` (Denoise / Raw Details / Super Resolution), which uses Adobe's own raw-processing pipeline rather than Topaz models.
- Distinct from the in-panel Detail sliders (`detail.md`), which are free, real-time, and non-generative.
