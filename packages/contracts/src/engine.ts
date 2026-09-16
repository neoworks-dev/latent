// The one service every UI plugin talks to. Typed over the generated protocol: a
// method name picks its params and result, so a plugin cannot send a shape the engine
// does not know. Frames arrive out of band via `onFrame`.
import type { FrameHeader, MethodMap, MethodName, NotificationMap } from "@latent/protocol";

export type EngineConnectionState = "connecting" | "open" | "closed";

export type FrameListener = (header: FrameHeader, pixels: Uint8ClampedArray) => void;

export interface EngineClient {
  readonly state: EngineConnectionState;
  /** Resolves on the next open socket, immediately when already open. */
  whenOpen(): Promise<void>;
  call<M extends MethodName>(
    method: M,
    params: MethodMap[M]["params"],
  ): Promise<MethodMap[M]["result"]>;
  /** Engine → UI notifications (stack.changed, engine.log). Returns the unsubscribe. */
  on<N extends keyof NotificationMap>(
    event: N,
    listener: (params: NotificationMap[N]) => void,
  ): () => void;
  /** Binary preview frames for a view. Returns the unsubscribe. */
  onFrame(viewId: number, listener: FrameListener): () => void;
}
