<script lang="ts">
  // The navigator: the whole photo, small, with a box around the part the viewer is
  // showing. Dragging in it aims the view — the same pan the canvas does, measured on the
  // little picture instead of the big one.
  //
  // The picture is the catalog's thumbnail rather than a second render: a navigator shows
  // where you are, not what the last slider did, and a second view would cost a GPU pass
  // per tick to say the same thing.
  import { kernelContext } from "@latent/contracts";
  import { panForPoint, visibleRect } from "./navigator";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const catalog = ctx.catalog;

  const photo = $derived(catalog.photos.find((entry) => entry.photoId === viewer.photoId));
  const url = $derived(photo ? catalog.thumbnailUrl(photo) : undefined);
  const rect = $derived(visibleRect(viewer.viewport));
  let dragging = $state(false);

  function aim(event: PointerEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const box = target.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const drawn = viewer.overlay.rect;
    const { dx, dy } = panForPoint(
      (event.clientX - box.x) / box.width,
      (event.clientY - box.y) / box.height,
      viewer.viewport,
      drawn.width,
      drawn.height,
    );
    viewer.panBy(dx, dy);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || viewer.viewport.fit) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
    aim(event);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    aim(event);
  }

  function endDrag(): void {
    dragging = false;
  }
</script>

<div class="px-3 pb-2" data-pane="navigator">
  {#if url}
    <!-- `presentation`, not a button: it is a picture you drag on, and the keyboard reaches
         the same zoom through the viewer's own shortcuts. -->
    <div
      class="relative overflow-hidden rounded-md border border-line bg-canvas"
      class:cursor-grab={!viewer.viewport.fit}
      class:cursor-grabbing={dragging}
      role="presentation"
      data-navigator
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
    >
      <img class="block w-full" src={url} alt="" draggable="false" />
      {#if !viewer.viewport.fit}
        <div
          class="pointer-events-none absolute border-2 border-action/90"
          style:left="{rect.x * 100}%"
          style:top="{rect.y * 100}%"
          style:width="{rect.width * 100}%"
          style:height="{rect.height * 100}%"
          data-navigator-view
        ></div>
      {/if}
    </div>
  {:else}
    <p class="rounded-md border border-line bg-canvas px-2 py-6 text-center text-xs text-faint">
      No photo open.
    </p>
  {/if}
  <p class="pt-1 text-2xs text-dim" data-navigator-zoom>{viewer.zoom}</p>
</div>
