import type { Histogram } from "@latent/protocol";

/** The graph's own coordinate box; the SVG scales it to whatever width the column has. */
export const BOX = { width: 256, height: 100 };

export type Channel = "r" | "g" | "b";

/** Lightroom lights a corner triangle at a quarter of a percent, which is about one pixel
 * in a thousand — low enough to catch a blown highlight, high enough that a stray sensor
 * pixel does not keep the warning on all the time. */
const CLIPPING_THRESHOLD = 0.25;

export interface Clipping {
  shadows: boolean;
  highlights: boolean;
  shadowsPct: number;
  highlightsPct: number;
}

/**
 * The count the graph is scaled against. The two end bins hold every clipped pixel of the
 * photo at once — a blown sky puts ten times the tallest real bin in bin 255 — so they are
 * left out of the scale and run off the top of the box instead of flattening everything
 * else. A completely flat frame has no peak and draws nothing.
 */
function peak(histogram: Histogram): number {
  let highest = 0;
  for (const channel of [histogram.r, histogram.g, histogram.b]) {
    for (let bin = 1; bin < channel.length - 1; bin++) {
      highest = Math.max(highest, channel[bin] ?? 0);
    }
  }
  return highest;
}

/**
 * One channel as a closed SVG path over `BOX`. The heights are square-rooted: a photo's
 * histogram is a few tall bins and a long low tail, and on a linear scale the tail is a
 * flat line one pixel high — the same reason Lightroom's graph is not linear either.
 */
export function channelPath(histogram: Histogram, channel: Channel): string {
  const bins = histogram[channel];
  const highest = peak(histogram);
  if (bins.length < 2 || highest === 0) return "";
  const step = BOX.width / (bins.length - 1);
  const points: string[] = [];
  for (let bin = 0; bin < bins.length; bin++) {
    const share = Math.min(1, Math.sqrt((bins[bin] ?? 0) / highest));
    const x = (bin * step).toFixed(2);
    const y = (BOX.height - share * BOX.height).toFixed(2);
    points.push(`${x} ${y}`);
  }
  return `M0 ${BOX.height} L${points.join(" L")} L${BOX.width} ${BOX.height} Z`;
}

/** The corner warnings: how much of the frame sits at either end of the scale. */
export function clippingOf(histogram: Histogram): Clipping {
  return {
    shadows: histogram.clippedShadowsPct >= CLIPPING_THRESHOLD,
    highlights: histogram.clippedHighlightsPct >= CLIPPING_THRESHOLD,
    shadowsPct: histogram.clippedShadowsPct,
    highlightsPct: histogram.clippedHighlightsPct,
  };
}

/** `0.4 %`, `12 %` — a share of the frame, at the precision it is worth reading. */
export function clippingLabel(percent: number): string {
  if (percent === 0) return "0 %";
  if (percent < 1) return `${percent.toFixed(2)} %`;
  return `${percent.toFixed(1)} %`;
}
