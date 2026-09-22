// Presets: a named bundle of op parameters, applied to whatever photo is open. Pure data
// and pure functions — the pane does the engine calls.
//
// A preset is not edit state and not a photo's business: it is a set of values to write,
// so it lives in this machine's storage, and applying one is the same op.update the
// sliders make. Nothing here reaches the stack.
// The imports are types only: `engine/tests/smoke.ts` reads `builtinPresets` to check every
// name in it against `ops.describe`, and a runtime import of the panel column would drag
// Svelte components into a plain bun script.
import type { CurvePoint } from "@latent/plugin-panels";
import type { Op } from "@latent/protocol";

/**
 * One parameter's value, as `op.update` takes it: a slider's number, an enum's string, a
 * toggle's boolean, or a tone curve's control points.
 */
export type PresetValue = number | string | boolean | CurvePoint[];

/** What one op should be set to. Values are the parameters' own. */
export type PresetOps = Record<string, Record<string, PresetValue>>;

export interface Preset {
  id: string;
  label: string;
  ops: PresetOps;
  /** The panel heading this row sits under. Absent on the user's own, which go under Yours. */
  group?: string;
  /** Ships with the app: it can be applied but not renamed or deleted. */
  builtin?: boolean;
}

/** Where the user's own presets are collected, since they carry no group of their own. */
export const userGroupLabel = "Yours";

/**
 * Ops are written in pipeline order, not registry order: white balance before tone, tone
 * before colour, colour before effects. Two ops of the same stage render in stack order
 * (renderer.cpp `in_stage_order`), so the order the keys are declared in below is the order
 * they take effect in — a colour grade declared before `saturation` would be desaturated by
 * it. Every op and parameter name here is `ops.describe`'s; a name the engine does not know
 * is dropped by `sanitize_stack` with a warning, which is a row that silently does less
 * than it says.
 *
 * The numbers come from published Lightroom recipes for each look (see issue #13); they are a
 * starting point on a normally exposed raw, the way Lightroom's own shipped presets are.
 */
export const builtinPresets: Preset[] = [
  // Essentials — one idea each, the moves that start most edits.
  {
    id: "builtin:punch",
    group: "Essentials",
    label: "Punch",
    builtin: true,
    ops: { contrast: { value: 25 }, vibrance: { value: 20 }, clarity: { value: 15 } },
  },
  {
    id: "builtin:recover",
    group: "Essentials",
    label: "Recover",
    builtin: true,
    ops: {
      highlights: { value: -60 },
      shadows: { value: 45 },
      whites: { value: -10 },
      blacks: { value: 10 },
      dehaze: { value: 8 },
    },
  },
  {
    id: "builtin:flat",
    group: "Essentials",
    label: "Flat (grade base)",
    builtin: true,
    ops: {
      contrast: { value: -25 },
      highlights: { value: -40 },
      shadows: { value: 40 },
      whites: { value: -15 },
      blacks: { value: 15 },
    },
  },
  {
    // The matte is the curve's, not the Blacks slider's: lifting the curve's own black point
    // is what fades a photo, and Blacks alone cannot reach it.
    id: "builtin:matte",
    group: "Essentials",
    label: "Soft matte",
    builtin: true,
    ops: {
      contrast: { value: -15 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0.08 },
          { x: 1, y: 0.96 },
        ],
      },
      clarity: { value: -10 },
    },
  },
  {
    id: "builtin:warm",
    group: "Essentials",
    label: "Warm",
    builtin: true,
    ops: { white_balance: { mode: "relative", temperature: 15 }, vibrance: { value: 10 } },
  },
  {
    id: "builtin:cool",
    group: "Essentials",
    label: "Cool",
    builtin: true,
    ops: { white_balance: { mode: "relative", temperature: -15 }, saturation: { value: -5 } },
  },

  // Portrait — skin lives in the Red and Orange bands, so every one of these is mostly the
  // colour mixer. Clarity is never positive here: it hardens skin texture.
  {
    id: "builtin:portrait-airy",
    group: "Portrait",
    label: "Bright & airy",
    builtin: true,
    ops: {
      exposure: { value: 0.25 },
      contrast: { value: -6 },
      highlights: { value: -60 },
      shadows: { value: 40 },
      whites: { value: 10 },
      blacks: { value: -6 },
      color_mixer: {
        redHue: -8,
        orangeSaturation: 6,
        orangeLuminance: 12,
        greenSaturation: -18,
        blueSaturation: -10,
      },
      texture: { value: -20 },
      clarity: { value: -15 },
    },
  },
  {
    id: "builtin:portrait-natural",
    group: "Portrait",
    label: "Natural skin",
    builtin: true,
    ops: {
      highlights: { value: -25 },
      shadows: { value: 18 },
      color_mixer: { redHue: 4, redSaturation: -8, orangeSaturation: -6, orangeLuminance: 10 },
      clarity: { value: -10 },
    },
  },
  {
    // Deep skin wants the lift in the shadows and in Orange luminance rather than in
    // exposure, which would blow the background out to hold the same face.
    id: "builtin:portrait-deep",
    group: "Portrait",
    label: "Deep skin",
    builtin: true,
    ops: {
      exposure: { value: 0.15 },
      contrast: { value: 8 },
      shadows: { value: 30 },
      blacks: { value: 8 },
      color_mixer: { orangeSaturation: -4, orangeLuminance: 18 },
      clarity: { value: -8 },
    },
  },
  {
    id: "builtin:portrait-edgy",
    group: "Portrait",
    label: "Edgy",
    builtin: true,
    ops: {
      contrast: { value: 30 },
      highlights: { value: -30 },
      blacks: { value: -25 },
      saturation: { value: -15 },
      color_mixer: { orangeSaturation: -10 },
      texture: { value: 18 },
      clarity: { value: 25 },
      vignette: { amount: -20, midpoint: 45 },
    },
  },

  // Landscape.
  {
    id: "builtin:golden-hour",
    group: "Landscape",
    label: "Golden hour",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: 12 },
      highlights: { value: -35 },
      shadows: { value: 25 },
      vibrance: { value: 20 },
      color_mixer: { orangeSaturation: 15, yellowLuminance: 10 },
      dehaze: { value: 10 },
    },
  },
  {
    id: "builtin:moody",
    group: "Landscape",
    label: "Moody dark",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: -12, tint: -5 },
      exposure: { value: -0.5 },
      contrast: { value: 35 },
      highlights: { value: -60 },
      shadows: { value: -20 },
      whites: { value: -25 },
      blacks: { value: -40 },
      vibrance: { value: -15 },
      saturation: { value: -10 },
      color_mixer: {
        orangeLuminance: -25,
        yellowSaturation: -10,
        greenSaturation: -15,
        greenLuminance: -15,
        aquaHue: -8,
        blueHue: -10,
        blueSaturation: 20,
        blueLuminance: -20,
      },
      clarity: { value: 20 },
      dehaze: { value: 20 },
      vignette: { amount: -35, midpoint: 45, feather: 55 },
      grain: { amount: 20, size: 35, roughness: 55 },
    },
  },
  {
    id: "builtin:dramatic-sky",
    group: "Landscape",
    label: "Dramatic sky",
    builtin: true,
    ops: {
      contrast: { value: 20 },
      highlights: { value: -50 },
      whites: { value: -15 },
      color_mixer: { aquaSaturation: 12, blueSaturation: 20, blueLuminance: -20 },
      clarity: { value: 20 },
      dehaze: { value: 30 },
      vignette: { amount: -20 },
    },
  },
  {
    id: "builtin:forest",
    group: "Landscape",
    label: "Lush forest",
    builtin: true,
    ops: {
      contrast: { value: 15 },
      shadows: { value: 20 },
      vibrance: { value: 18 },
      color_mixer: {
        yellowHue: 10,
        yellowSaturation: 12,
        greenHue: -12,
        greenSaturation: 20,
        greenLuminance: -8,
      },
      texture: { value: 10 },
      clarity: { value: 12 },
      dehaze: { value: 10 },
    },
  },
  {
    id: "builtin:blue-hour",
    group: "Landscape",
    label: "Blue hour",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: -18, tint: 6 },
      exposure: { value: -0.15 },
      contrast: { value: 12 },
      shadows: { value: 25 },
      blacks: { value: -15 },
      color_mixer: { aquaSaturation: 10, blueSaturation: 18, blueLuminance: 8 },
      clarity: { value: 10 },
    },
  },

  // Cinematic — complementary grades. Orange is where skin already sits, teal is opposite
  // it, and the separation between the two is the whole effect; the colour grading wheels
  // add the tone rather than pushing colours the photo already has.
  {
    id: "builtin:teal-orange",
    group: "Cinematic",
    label: "Teal & orange",
    builtin: true,
    ops: {
      exposure: { value: 0.1 },
      contrast: { value: 15 },
      highlights: { value: -10 },
      shadows: { value: 20 },
      whites: { value: 10 },
      blacks: { value: -10 },
      vibrance: { value: 10 },
      color_mixer: { orangeSaturation: 12, aquaSaturation: 12, blueSaturation: 10 },
      // Blending widens the three weights until they overlap. Narrow, they all fall to zero
      // on a frame that is mostly midtones (`color_grading` in ops.wgsl) and the grade does
      // nothing at all — so a split tone meant to be seen is blended wide, not tight.
      color_grading: {
        shadowHue: 200,
        shadowSaturation: 30,
        highlightHue: 35,
        highlightSaturation: 26,
        blending: 65,
        balance: 10,
      },
      vignette: { amount: -10 },
      sharpening: { amount: 30, radius: 1, detail: 25, masking: 20 },
    },
  },
  {
    id: "builtin:blockbuster",
    group: "Cinematic",
    label: "Blockbuster",
    builtin: true,
    ops: {
      contrast: { value: 25 },
      highlights: { value: -40 },
      shadows: { value: 10 },
      blacks: { value: -30 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0.04 },
          { x: 0.25, y: 0.22 },
          { x: 0.75, y: 0.8 },
          { x: 1, y: 1 },
        ],
      },
      saturation: { value: -8 },
      color_grading: {
        shadowHue: 210,
        shadowSaturation: 30,
        shadowLuminance: -5,
        midtoneHue: 30,
        midtoneSaturation: 10,
        highlightHue: 45,
        highlightSaturation: 20,
        blending: 60,
      },
      clarity: { value: 12 },
      vignette: { amount: -25, midpoint: 40 },
    },
  },
  {
    id: "builtin:neon-night",
    group: "Cinematic",
    label: "Neon night",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: -10, tint: 12 },
      exposure: { value: -0.2 },
      highlights: { value: -40 },
      shadows: { value: 15 },
      blacks: { value: -25 },
      color_mixer: {
        aquaSaturation: 15,
        blueSaturation: 20,
        purpleSaturation: 12,
        magentaSaturation: 18,
      },
      color_grading: {
        shadowHue: 265,
        shadowSaturation: 28,
        highlightHue: 320,
        highlightSaturation: 22,
        blending: 60,
      },
      clarity: { value: 15 },
      grain: { amount: 15, size: 25 },
    },
  },

  // Film — the shape of a film stock is a curve that never reaches black or white, plus a
  // cast in the deepest tones (a stock's base fog). Both ends are compressed, not just the
  // shadows; grain is part of the look rather than a defect.
  {
    id: "builtin:faded-film",
    group: "Film",
    label: "Faded film",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: 6 },
      contrast: { value: -10 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0.09 },
          { x: 0.25, y: 0.29 },
          { x: 0.75, y: 0.78 },
          { x: 1, y: 0.94 },
        ],
      },
      saturation: { value: -8 },
      color_grading: {
        shadowHue: 95,
        shadowSaturation: 8,
        highlightHue: 45,
        highlightSaturation: 10,
        blending: 65,
      },
      grain: { amount: 25, size: 30, roughness: 55 },
    },
  },
  {
    id: "builtin:slide-film",
    group: "Film",
    label: "Slide film",
    builtin: true,
    ops: {
      white_balance: { mode: "relative", temperature: 8 },
      contrast: { value: 22 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.2 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 1 },
        ],
      },
      vibrance: { value: 12 },
      color_mixer: { redSaturation: 10, yellowHue: -8, greenHue: 8, blueSaturation: 12 },
      clarity: { value: 8 },
    },
  },
  {
    id: "builtin:pastel",
    group: "Film",
    label: "Soft pastel",
    builtin: true,
    ops: {
      contrast: { value: -8 },
      highlights: { value: -30 },
      shadows: { value: 25 },
      blacks: { value: 12 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0.06 },
          { x: 1, y: 0.97 },
        ],
      },
      vibrance: { value: 10 },
      saturation: { value: -6 },
      color_mixer: { orangeHue: 6, greenSaturation: -20, aquaSaturation: -12 },
      texture: { value: -12 },
    },
  },
  {
    // Cross processing is per-channel: red lifted and blue clipped is the cyan-shadow,
    // yellow-highlight cast of C-41 chemistry run on slide film.
    id: "builtin:cross-process",
    group: "Film",
    label: "Cross process",
    builtin: true,
    ops: {
      contrast: { value: 18 },
      tone_curve: {
        red: [
          { x: 0, y: 0.08 },
          { x: 0.5, y: 0.52 },
          { x: 1, y: 1 },
        ],
        green: [
          { x: 0, y: 0.02 },
          { x: 1, y: 0.98 },
        ],
        blue: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.45 },
          { x: 1, y: 0.92 },
        ],
      },
      saturation: { value: 12 },
      clarity: { value: 10 },
    },
  },

  // Black & white. `saturation` runs before `color_mixer`, so a hue-based dodge after the
  // conversion would do nothing — what still reads on a grey frame is the colour grading,
  // which is the darkroom toner.
  {
    id: "builtin:mono",
    group: "Black & white",
    label: "Black & white",
    builtin: true,
    ops: { contrast: { value: 15 }, saturation: { value: -100 }, clarity: { value: 10 } },
  },
  {
    id: "builtin:mono-contrast",
    group: "Black & white",
    label: "High contrast mono",
    builtin: true,
    ops: {
      contrast: { value: 45 },
      highlights: { value: -25 },
      shadows: { value: -15 },
      whites: { value: 20 },
      blacks: { value: -30 },
      saturation: { value: -100 },
      texture: { value: 15 },
      clarity: { value: 25 },
    },
  },
  {
    id: "builtin:mono-soft",
    group: "Black & white",
    label: "Soft mono",
    builtin: true,
    ops: {
      contrast: { value: -10 },
      highlights: { value: -20 },
      shadows: { value: 25 },
      blacks: { value: 12 },
      tone_curve: {
        rgb: [
          { x: 0, y: 0.08 },
          { x: 1, y: 0.96 },
        ],
      },
      saturation: { value: -100 },
      clarity: { value: -8 },
      grain: { amount: 20, size: 30 },
    },
  },
  {
    id: "builtin:sepia",
    group: "Black & white",
    label: "Sepia",
    builtin: true,
    ops: {
      contrast: { value: 12 },
      saturation: { value: -100 },
      // A toner stains the whole print, not one end of it, so the weight that carries it is
      // the Global wheel's — which is 1.0 everywhere. Shadows and highlights only split the
      // warmth after that.
      color_grading: {
        shadowHue: 24,
        shadowSaturation: 18,
        highlightHue: 40,
        highlightSaturation: 16,
        globalHue: 28,
        globalSaturation: 30,
        blending: 65,
      },
    },
  },
  {
    id: "builtin:selenium",
    group: "Black & white",
    label: "Selenium",
    builtin: true,
    ops: {
      contrast: { value: 18 },
      saturation: { value: -100 },
      // A blue-violet tint is far stronger per point of saturation than a warm one: `grade`
      // divides the tint by its own luma, and a violet's is a fifth of an orange's. Selenium
      // is a whisper of one, so the numbers here are small on purpose.
      color_grading: {
        shadowHue: 262,
        shadowSaturation: 7,
        highlightHue: 40,
        highlightSaturation: 8,
        blending: 45,
      },
    },
  },

  // Detail — sharpening and noise reduction only, so they stack under any look above.
  {
    id: "builtin:crisp",
    group: "Detail",
    label: "Crisp detail",
    builtin: true,
    ops: {
      texture: { value: 15 },
      clarity: { value: 8 },
      sharpening: { amount: 65, radius: 1.1, detail: 30, masking: 45 },
      noise_reduction: { luminance: 12, detail: 50 },
    },
  },
  {
    // High masking keeps the sharpening off the flat areas the noise reduction just
    // smoothed, which is what stops the two from fighting.
    id: "builtin:clean-high-iso",
    group: "Detail",
    label: "Clean high ISO",
    builtin: true,
    ops: {
      sharpening: { amount: 45, radius: 1, detail: 20, masking: 60 },
      noise_reduction: { luminance: 40, detail: 55, contrast: 10 },
      color_noise_reduction: { amount: 35, detail: 50, smoothness: 55 },
    },
  },
];

/** Ops whose values a preset has no business carrying. */
const notPresettable = ["crop", "group", "generative_fill", "remove"];

/**
 * One value as a preset can carry it, or null for anything that does not travel. A curve is
 * taken as the stack holds it — sorting and clamping are the engine's, on the way back in.
 */
function presetValue(value: unknown): PresetValue | null {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: CurvePoint[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const point = entry as { x?: unknown; y?: unknown };
    if (typeof point.x !== "number" || typeof point.y !== "number") return null;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

/**
 * The open photo's own values as a preset. Masked and generative work is left out: a mask
 * is drawn on one photo and means nothing on the next, and a generative raster is pixels
 * rather than parameters.
 */
export function capturePreset(label: string, stack: Op[], id: string): Preset {
  const ops: PresetOps = {};
  for (const entry of stack) {
    if (!entry.enabled || entry.mask || notPresettable.includes(entry.op)) continue;
    const params: Record<string, PresetValue> = {};
    for (const [key, value] of Object.entries(entry.params)) {
      const carried = presetValue(value);
      if (carried !== null) params[key] = carried;
    }
    if (Object.keys(params).length > 0) ops[entry.op] = params;
  }
  return { id, label, ops };
}

/**
 * The stack a preset leaves behind. An op the preset names and the photo already has is
 * written in place — a preset moves the sliders that are there rather than stacking a second
 * copy on them — and everything it does not name is carried through untouched: the crop, the
 * layers, the generative rasters, the ops of whatever preset ran before it. A masked op is
 * somebody's layer, so a global preset writes past it and appends its own.
 */
export function applyPreset(preset: Preset, stack: Op[]): Op[] {
  const targets = new Set<string>();
  const next = stack.map((entry) => {
    const params = preset.ops[entry.op];
    if (!params || entry.mask) return entry;
    targets.add(entry.op);
    return { ...entry, params: { ...entry.params, ...params }, enabled: true };
  });
  for (const [op, params] of Object.entries(preset.ops)) {
    // An empty id is the engine's cue to mint one (`sanitize_stack`), the same as op.add.
    if (!targets.has(op)) next.push({ id: "", op, params: { ...params }, enabled: true });
  }
  return next;
}

/** How many sliders a preset writes — what its row shows beside the name. */
export function presetSize(preset: Preset): number {
  return Object.values(preset.ops).reduce((total, params) => total + Object.keys(params).length, 0);
}

export interface PresetGroup {
  label: string;
  presets: Preset[];
}

/**
 * The panel's rows, headed and in order: the shipped groups as `builtinPresets` lists them,
 * then the user's own under Yours.
 */
export function presetGroups(user: Preset[]): PresetGroup[] {
  const groups: PresetGroup[] = [];
  for (const preset of [...builtinPresets, ...user]) {
    const label = preset.group ?? userGroupLabel;
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.presets.push(preset);
    else groups.push({ label, presets: [preset] });
  }
  return groups;
}

/**
 * The saved presets, defended against a storage entry written by an older build or edited
 * by hand: anything that is not a preset is dropped rather than drawn as an empty row.
 */
export function readPresets(raw: string | null): Preset[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPreset);
  } catch {
    return [];
  }
}

function isPreset(value: unknown): value is Preset {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Preset>;
  if (typeof entry.id !== "string" || typeof entry.label !== "string") return false;
  return typeof entry.ops === "object" && entry.ops !== null;
}
