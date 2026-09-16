# Detail

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#detail (fetched 2026-09-16)

Sharpen a photo to enhance edge definition and detail, and remove image noise (luminance/grayscale noise makes an image look grainy; chroma/color noise appears as colored artifacts). High-ISO photos commonly show noticeable noise.

## Sharpening

| Control | Range | Description |
|---|---|---|
| Sharpening (Amount) | unstated (right = more sharpening) | Sharpens edge definition |
| Radius | unstated | Size of details sharpening is applied to; fine-detail photos may need a lower radius, larger-detail photos a larger radius. Too large a radius gives unnatural results |
| Detail | unstated | How much high-frequency information is sharpened / how much edges are emphasized; lower = sharpen edges to remove blur, higher = make textures more pronounced |
| Masking | unstated (0–100 implied by description) | Edge mask: 0 = everything sharpened equally; 100 = sharpening mostly restricted to the strongest edges |

## Denoise / Noise Reduction

| Control | Range | Description |
|---|---|---|
| Denoise | button (AI) | Automatically corrects noisy images using AI-powered Denoise (see `enhance-details.md` for the full-resolution AI Denoise workflow) |
| Noise Reduction (luminance, Amount) | unstated (right = more reduction) | Manually reduces luminance noise |
| Noise Reduction: Detail | unstated | Luminance noise threshold; higher = preserves more detail but noisier results, lower = cleaner but may remove detail |
| Noise Reduction: Contrast | unstated | Luminance contrast; higher = preserves contrast but may produce noisy blotches/mottling, lower = smoother but less contrast |
| Color Noise Reduction (Amount) | unstated (right = more reduction) | Reduces color (chroma) noise |
| Color Noise Reduction: Detail | unstated | Color noise threshold; higher = protects thin detailed color edges but may speckle, lower = removes speckles but may bleed color |
| Color Noise Reduction: Smoothness | unstated | Higher = more softening applied to speckled color tones |

## Grain

| Control | Range | Description |
|---|---|---|
| Grain (Amount) | unstated (right = add grain) | Adds simulated film grain |
| Grain: Size | unstated (≥25 adds a blue tint to look better with noise reduction) | Controls grain particle size |
| Grain: Roughness | unstated (left = more uniform, right = more uneven) | Controls the regularity of the grain |

## Interactions

- See `enhance-details.md` for Denoise / Raw Details / Super Resolution — separate, non-destructive full-image AI enhancements that produce a new stacked DNG, distinct from the in-panel Denoise button/Noise Reduction sliders above.
- See `enhance-generative-ai.md` for Generative Upscale and AI Sharpen (Topaz-powered), also distinct from the sliders above.
- The same Sharpness/Noise Reduction concepts reappear as local-adjustment sliders inside Masking — see `masking.md`.
