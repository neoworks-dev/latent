// Service keys available on every plugin's `ctx`. Each provider augments Context in its
// own module; the core set is declared here so consumers get types before any plugin loads.
import type { EngineClient } from "./engine";
import type { GeometryView } from "./geometry";
import type { PaneRegistry } from "./panes";
import type { ViewerService } from "./viewer";

declare module "@neoworks/extension-system" {
  interface Context {
    engine: EngineClient;
    panes: PaneRegistry;
    viewer: ViewerService;
    geometryView: GeometryView;
  }
}
