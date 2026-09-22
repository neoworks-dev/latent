import { describe, expect, test } from "bun:test";
import type { JobProgressParams } from "@latent/protocol";
import {
  countProblem,
  defaultMergeOptions,
  foldProgress,
  mergeMethod,
  mergeParams,
  previewParams,
  previewSignature,
  progressFraction,
  progressLabel,
  showsHdrOptions,
  showsPanoramaOptions,
  showsStarTrailOptions,
  trackJob,
  type MergeOptions,
} from "../src/merge";
import { PreviewRequester } from "../src/preview";

const options: MergeOptions = {
  autoAlign: false,
  deghost: "medium",
  projection: "cylindrical",
  boundaryWarp: 40,
  autoCrop: false,
  blend: "average",
  gapFill: 3,
  foreground: "firstFrame",
  foregroundThreshold: 8,
  decay: 60,
};

function progress(overrides: Partial<JobProgressParams>): JobProgressParams {
  return { jobId: 7, kind: "merge", done: 1, total: 4, finished: false, ...overrides };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("which options a kind shows", () => {
  test("HDR shows the exposure half, Panorama the stitching half, HDR Panorama both", () => {
    expect([showsHdrOptions("hdr"), showsPanoramaOptions("hdr")]).toEqual([true, false]);
    expect([showsHdrOptions("panorama"), showsPanoramaOptions("panorama")]).toEqual([false, true]);
    expect([showsHdrOptions("hdrPanorama"), showsPanoramaOptions("hdrPanorama")]).toEqual([
      true,
      true,
    ]);
  });

  test("each kind calls its own method", () => {
    expect(mergeMethod("hdr")).toBe("merge.hdr");
    expect(mergeMethod("panorama")).toBe("merge.panorama");
    expect(mergeMethod("hdrPanorama")).toBe("merge.hdrPanorama");
  });

  test("the schema's photo counts are what the dialog refuses on", () => {
    expect(countProblem("hdr", 3)).toBe("");
    expect(countProblem("hdr", 1)).toContain("at least 2");
    expect(countProblem("hdr", 8)).toContain("at most 7");
    expect(countProblem("panorama", 12)).toBe("");
    expect(countProblem("hdrPanorama", 3)).toContain("at least 4");
  });
});

describe("selection → params", () => {
  test("an HDR merge sends only the fields merge.hdr accepts", () => {
    expect(mergeParams("hdr", [4, 5, 6], options)).toEqual({
      photoIds: [4, 5, 6],
      autoAlign: false,
      deghost: "medium",
    });
  });

  test("a panorama sends only the layout fields", () => {
    expect(mergeParams("panorama", [1, 2], options)).toEqual({
      photoIds: [1, 2],
      projection: "cylindrical",
      boundaryWarp: 40,
      autoCrop: false,
    });
  });

  test("an HDR panorama sends both halves", () => {
    expect(mergeParams("hdrPanorama", [1, 2, 3, 4], options)).toEqual({
      photoIds: [1, 2, 3, 4],
      autoAlign: false,
      deghost: "medium",
      projection: "cylindrical",
      boundaryWarp: 40,
      autoCrop: false,
    });
  });

  test("the params are a copy: editing the selection afterwards cannot change them", () => {
    const selection = [1, 2];
    const params = mergeParams("panorama", selection, defaultMergeOptions);
    selection.push(3);
    expect(params.photoIds).toEqual([1, 2]);
  });

  test("a preview is the merge's params plus the kind and the long edge", () => {
    expect(previewParams("panorama", [1, 2], options)).toEqual({
      photoIds: [1, 2],
      projection: "cylindrical",
      boundaryWarp: 40,
      autoCrop: false,
      kind: "panorama",
      longEdge: 1024,
    });
  });

  test("the signature ignores options the kind does not send", () => {
    const warped = { ...defaultMergeOptions, boundaryWarp: 90 };
    expect(previewSignature("hdr", [1, 2], warped)).toBe(
      previewSignature("hdr", [1, 2], defaultMergeOptions),
    );
    expect(previewSignature("panorama", [1, 2], warped)).not.toBe(
      previewSignature("panorama", [1, 2], defaultMergeOptions),
    );
  });
});

describe("job.progress → state", () => {
  test("a notification for another job leaves the tracked one alone", () => {
    const tracked = trackJob(7);
    expect(foldProgress(tracked, progress({ jobId: 9, done: 3 }))).toBe(tracked);
    expect(foldProgress(null, progress({}))).toBeNull();
  });

  test("a running tick moves the counts and defaults the state", () => {
    const folded = foldProgress(trackJob(7), progress({ done: 2, message: "merging" }));
    expect(folded).toMatchObject({ done: 2, total: 4, finished: false, state: "running" });
    expect(folded?.result).toBeNull();
    expect(progressFraction(folded)).toBe(0.5);
    expect(progressLabel(folded)).toBe("merging");
  });

  test("the last notification carries the result the dialog opens", () => {
    const running = foldProgress(trackJob(7), progress({ done: 2 }));
    const done = foldProgress(
      running,
      progress({ done: 4, finished: true, state: "done", result: { photoId: 42, path: "/a.tif" } }),
    );
    expect(done?.finished).toBe(true);
    expect(done?.result).toEqual({ photoId: 42, path: "/a.tif" });
    expect(progressFraction(done)).toBe(1);
  });

  test("a result from an earlier tick is kept when the last one omits it", () => {
    const withResult = foldProgress(
      trackJob(7),
      progress({ done: 3, result: { previewUrl: "http://127.0.0.1:1/preview/a.png" } }),
    );
    const finished = foldProgress(withResult, progress({ done: 4, finished: true }));
    expect(finished?.result?.previewUrl).toBe("http://127.0.0.1:1/preview/a.png");
    expect(finished?.state).toBe("done");
  });

  test("an error is what the line under the bar says", () => {
    const failed = foldProgress(
      trackJob(7),
      progress({ finished: true, state: "error", error: "not enough overlap" }),
    );
    expect(progressLabel(failed)).toBe("not enough overlap");
    expect(progressLabel(null)).toBe("");
    expect(progressFraction(null)).toBe(0);
  });
});

describe("preview debounce and one in flight", () => {
  /** A run that only settles when the test says so — a job, not a call. */
  function controllable(): {
    run: (signature: string) => Promise<void>;
    sent: string[];
    settle: () => void;
  } {
    const sent: string[] = [];
    let release: (() => void) | null = null;
    return {
      sent,
      run: (signature) => {
        sent.push(signature);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      settle: () => {
        const resolve = release;
        release = null;
        if (resolve) resolve();
      },
    };
  }

  test("a burst inside the window is one call, and it carries the newest signature", async () => {
    const control = controllable();
    const requester = new PreviewRequester(control.run, 20);
    requester.request("a");
    requester.request("b");
    requester.request("c");
    await sleep(60);
    expect(control.sent).toEqual(["c"]);
  });

  test("a request made while a job runs waits for it, then goes out once", async () => {
    const control = controllable();
    const requester = new PreviewRequester(control.run, 20);
    requester.request("a");
    await sleep(60);
    expect(control.sent).toEqual(["a"]);

    requester.request("b");
    requester.request("c");
    await sleep(60);
    // Still only "a": the job it started has not finished, so nothing else may go out.
    expect(control.sent).toEqual(["a"]);

    control.settle();
    await sleep(20);
    expect(control.sent).toEqual(["a", "c"]);
  });

  test("asking again for what is already on screen costs no call", async () => {
    const control = controllable();
    const requester = new PreviewRequester(control.run, 20);
    requester.request("a");
    await sleep(60);
    control.settle();
    await sleep(20);
    requester.request("a");
    await sleep(60);
    expect(control.sent).toEqual(["a"]);
  });

  test("a change and back while the job runs does not re-send it", async () => {
    const control = controllable();
    const requester = new PreviewRequester(control.run, 20);
    requester.request("a");
    await sleep(60);
    requester.request("b");
    requester.request("a");
    await sleep(60);
    control.settle();
    await sleep(40);
    expect(control.sent).toEqual(["a"]);
  });

  test("drop forgets the pending request and lets a reopened dialog ask again", async () => {
    const control = controllable();
    const requester = new PreviewRequester(control.run, 20);
    requester.request("a");
    requester.drop();
    await sleep(60);
    expect(control.sent).toEqual([]);

    requester.request("a");
    await sleep(60);
    expect(control.sent).toEqual(["a"]);
  });
});

describe("star trails", () => {
  test("the night sequence options are their own half of the dialog", () => {
    expect([
      showsHdrOptions("starTrail"),
      showsPanoramaOptions("starTrail"),
      showsStarTrailOptions("starTrail"),
    ]).toEqual([false, false, true]);
    expect(showsStarTrailOptions("hdr")).toBe(false);
  });

  test("a star trail merge sends the stacking options and nothing else", () => {
    expect(mergeMethod("starTrail")).toBe("merge.starTrail");
    expect(mergeParams("starTrail", [4, 5, 6], options)).toEqual({
      photoIds: [4, 5, 6],
      blend: "average",
      gapFill: 3,
      foreground: "firstFrame",
      foregroundThreshold: 8,
      decay: 60,
    });
  });

  test("a sequence is allowed to be long, and one frame is not a sequence", () => {
    expect(countProblem("starTrail", 240)).toBe("");
    expect(countProblem("starTrail", 1)).toContain("at least 2");
    expect(countProblem("starTrail", 501)).toContain("at most 500");
  });

  test("the preview asks for the same stack at preview size", () => {
    const params = previewParams("starTrail", [4, 5], options);
    expect(params.kind).toBe("starTrail");
    expect(params.decay).toBe(60);
    expect(params.longEdge).toBe(1024);
    // Switching to a kind that ignores the trail options and back is the same preview.
    expect(previewSignature("starTrail", [4, 5], options)).toBe(
      previewSignature("starTrail", [4, 5], { ...options }),
    );
  });

  test("the defaults are a plain lighten stack", () => {
    expect(defaultMergeOptions.blend).toBe("lighten");
    expect(defaultMergeOptions.gapFill).toBe(0);
    expect(defaultMergeOptions.decay).toBe(0);
  });
});
