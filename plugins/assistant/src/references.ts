// Reference images the user attaches to a message: pasted, dropped or picked. They go to
// the agent as ACP image blocks, so they are downscaled here — a phone photo would be
// megabytes of base64 per turn, and the models see no more than about this much anyway.

export interface Reference {
  /** Base64, no `data:` prefix: an ACP image block's `data`. */
  data: string;
  mimeType: string;
  /** The same image as a data URL, for the thumbnail. */
  url: string;
}

export const MAX_REFERENCES = 4;
const LONG_EDGE = 1568;

export async function readReference(file: Blob): Promise<Reference> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas to scale the reference with");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = await dataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
  return { data: url.slice(url.indexOf(",") + 1), mimeType: "image/jpeg", url };
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("the image did not read as a data URL"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("could not read the image")),
    );
    reader.readAsDataURL(blob);
  });
}
