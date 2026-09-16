// The one service every UI plugin talks to. Typed over the generated protocol: a
// method name picks its params and result, so a plugin cannot send a shape the engine
// does not know. Frames arrive out of band via `onFrame`.
import type { FrameHeader, MethodMap, MethodName, NotificationMap } from "@latent/protocol";

export type EngineConnectionState = "connecting" | "open" | "closed";

/**
 * One `LFRM` frame, handed over without a copy. `pixels` is a view into the socket's own
 * buffer and is only valid for the duration of the call — upload it, do not retain it.
 * The marks are the only place the arrival time is knowable, so the client passes them on.
 */
export interface EngineFrame {
  header: FrameHeader;
  /** rgba8 sRGB, row-major, `header.width * header.height * 4` bytes. */
  pixels: Uint8Array;
  /** `performance.now()` when the socket message fired. */
  receivedAt: number;
  /** `performance.now()` once the 32-byte header was read. */
  parsedAt: number;
}

export type FrameListener = (frame: EngineFrame) => void;

/** `jpeg` is the frame's payload as a Blob — pixels stay binary, never base64 in JSON. */
export type ThumbnailListener = (header: FrameHeader, jpeg: Blob) => void;

export interface EngineClient {
  readonly state: EngineConnectionState;
  /** Resolves on the next open socket, immediately when already open. */
  whenOpen(): Promise<void>;
  call<M extends MethodName>(
    method: M,
    params: MethodMap[M]["params"],
  ): Promise<MethodMap[M]["result"]>;
  /**
   * Engine → UI notifications (stack.changed, engine.log, catalog.changed, job.progress,
   * python.output). Returns the unsubscribe.
   */
  on<N extends keyof NotificationMap>(
    event: N,
    listener: (params: NotificationMap[N]) => void,
  ): () => void;
  /** Binary preview frames (LFRM) for a view. Returns the unsubscribe. */
  onFrame(viewId: number, listener: FrameListener): () => void;
  /**
   * Binary thumbnail frames (LTHM) for a photo, sent before the `catalog.thumbnail` or
   * `catalog.thumbnails` result. Subscribe before calling; a photo listed in the batch
   * result's `missing` never gets a frame. Returns the unsubscribe.
   */
  onThumbnail(photoId: number, listener: ThumbnailListener): () => void;
}
