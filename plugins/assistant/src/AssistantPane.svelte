<script lang="ts">
  // The Assistant column: what the mode does and whether the neo daemon is there. The
  // conversation itself floats over the photo, next to the region it is about.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner } from "@neoworks-dev/ui";
  import FrameCornersIcon from "phosphor-svelte/lib/FrameCornersIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const assistant = ctx.assistant;
  const viewer = ctx.viewer;
</script>

<div
  class="flex flex-col gap-2 px-3 pb-3 text-xs"
  data-pane="assistant"
  data-status={assistant.status}
>
  {#if assistant.status === "connecting"}
    <span class="flex items-center gap-2 text-muted">
      <LoadingSpinner size={12} label="connecting" />
      Connecting to neo…
    </span>
  {:else if assistant.status === "unavailable"}
    <p class="text-red" data-assistant-error>{assistant.error}</p>
  {:else}
    <p class="text-muted">
      Drag a box over the part of the photo you want changed, or click the photo to talk about all
      of it, then say what to do. Paste or drop images into the chat as references. The agent edits
      through the same stack you do: every change is a layer you can undo.
    </p>
    <Button
      size="sm"
      icon={FrameCornersIcon}
      disabled={viewer.photoId === null}
      onclick={() => assistant.select("photo")}>Ask about the whole photo</Button
    >
  {/if}
</div>
