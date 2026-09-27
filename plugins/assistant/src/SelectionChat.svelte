<script lang="ts">
  // The selection chat: in the Assistant rail mode a drag on the photo selects a box, and a
  // chat card floats next to it, following zoom and pan; a click asks about the whole photo,
  // and the card docks at the bottom. The card is DOM over the viewer, not overlay drawing,
  // so it can take text and images; the box itself is overlay drawing.
  import type { OverlayMap, OverlayPointer } from "@latent/contracts";
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, Select } from "@neoworks-dev/ui";
  import type { Effort, HarnessId } from "@neoworks/harness/client";
  import FrameCornersIcon from "phosphor-svelte/lib/FrameCornersIcon";
  import PaperclipIcon from "phosphor-svelte/lib/PaperclipIcon";
  import PaperPlaneRightIcon from "phosphor-svelte/lib/PaperPlaneRightIcon";
  import StopIcon from "phosphor-svelte/lib/StopIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import {
    ASSISTANT_MODE,
    boxFromDrag,
    chatPosition,
    dockedPosition,
    HARNESS_LABELS,
    type Box,
    type Point,
  } from "./assistant";
  import { MAX_REFERENCES } from "./references";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const assistant = ctx.assistant;
  const viewer = ctx.viewer;

  const CHAT_WIDTH = 340;

  let viewerWidth = $state(0);
  let viewerHeight = $state(0);
  let chatHeight = $state(0);
  let instruction = $state("");
  let drag = $state<{ start: Point; current: Point } | null>(null);
  let transcript = $state<HTMLDivElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);

  const active = $derived(ctx.panes.mode === ASSISTANT_MODE);
  const box = $derived(assistant.target === "photo" ? null : assistant.target);

  /** The selection's bounds on screen. Re-read on every zoom, pan, resize or crop. */
  const selectionOnScreen = $derived.by(() => {
    void viewer.frameGeometry;
    void viewer.overlay.rect;
    if (!box) return null;
    return screenBounds(box, viewer.overlay.map);
  });

  const chatAt = $derived.by(() => {
    const chat = { width: CHAT_WIDTH, height: chatHeight };
    const view = { width: viewerWidth, height: viewerHeight };
    if (assistant.target === "photo") return dockedPosition(chat, view, ctx.panes.safeArea);
    return selectionOnScreen && chatPosition(selectionOnScreen, chat, view, ctx.panes.safeArea);
  });

  const harnessOptions = $derived(
    assistant.harnesses.map((harness) => ({
      value: harness.id,
      label: HARNESS_LABELS[harness.id],
    })),
  );
  const modelOptions = $derived([
    { value: "", label: "Default model" },
    ...(assistant.models[assistant.settings.harness] ?? []).map((model) => ({
      value: model.id,
      label: model.name,
    })),
  ]);
  const effortOptions = $derived([
    { value: "", label: "Default effort" },
    ...(
      assistant.harnesses.find((harness) => harness.id === assistant.settings.harness)?.efforts ??
      []
    ).map((effort) => ({ value: effort, label: effort })),
  ]);

  function corners(box: Box, map: OverlayMap): { x: number; y: number }[] {
    const [x0, y0, x1, y1] = box;
    return [map.toCanvas(x0, y0), map.toCanvas(x1, y0), map.toCanvas(x1, y1), map.toCanvas(x0, y1)];
  }

  // Straighten and keystone turn the image-space box into any quadrilateral on screen.
  function screenBounds(
    box: Box,
    map: OverlayMap,
  ): { left: number; top: number; right: number; bottom: number } {
    const points = corners(box, map);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  }

  function drawBox(
    context: CanvasRenderingContext2D,
    box: Box,
    map: OverlayMap,
    dashed: boolean,
  ): void {
    const points = corners(box, map);
    context.save();
    // Solid is the default; restore() below puts it back.
    if (dashed) context.setLineDash([6, 4]);
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.shadowColor = "rgba(0, 0, 0, 0.6)";
    context.shadowBlur = 3;
    context.beginPath();
    for (const point of points) context.lineTo(point.x, point.y);
    context.closePath();
    context.stroke();
    context.restore();
  }

  function drawOverlay(context: CanvasRenderingContext2D, _rect: unknown, map: OverlayMap): void {
    if (drag) {
      const box = boxFromDrag(drag.start, drag.current);
      if (box) drawBox(context, box, map, true);
      return;
    }
    if (box) drawBox(context, box, map, false);
  }

  function onPointer(event: OverlayPointer): boolean {
    if (!active || event.kind === "wheel") return false;
    // Image space: the box outlives a later crop, like a mask component's coordinates.
    const point: Point = [event.imageX, event.imageY];
    if (event.kind === "down") {
      drag = { start: point, current: point };
      return true;
    }
    if (!drag) return false;
    if (event.kind === "move") {
      drag = { start: drag.start, current: point };
      viewer.overlay.redraw();
      return true;
    }
    const finished = drag;
    drag = null;
    viewer.overlay.redraw();
    if (event.kind === "cancel") return true;
    const dragged = boxFromDrag(finished.start, point);
    // A click is a question about the whole photo — unless a chat is already open, where a
    // stray click should not move it; the card has its own switch for that.
    if (dragged) assistant.select(dragged);
    else if (!assistant.target) assistant.select("photo");
    return true;
  }

  function attach(files: FileList | null | undefined): void {
    if (files?.length) void assistant.attach(files);
  }

  function onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (!files?.length) return;
    event.preventDefault();
    attach(files);
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    attach(event.dataTransfer?.files);
  }

  function send(): void {
    const text = instruction;
    instruction = "";
    void assistant.send(text);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  }

  function searchOptions(option: { label: string }, query: string): boolean {
    return option.label.toLowerCase().includes(query.toLowerCase());
  }

  // The box and the drag are drawn whenever there is one; the pointer is only taken in the
  // Assistant mode, so every other tool keeps the photo to itself.
  $effect(() => {
    const detachDraw = viewer.overlay.attachOverlay(drawOverlay);
    const detachPointer = viewer.overlay.onPointer(onPointer);
    return () => {
      detachDraw();
      detachPointer();
    };
  });

  $effect(() => {
    if (!active) return;
    return viewer.overlay.setCursor("crosshair");
  });

  // A new selection or a finished chat redraws the box.
  $effect(() => {
    void assistant.target;
    viewer.overlay.redraw();
  });

  $effect(() => {
    const element = transcript;
    if (!element || assistant.items.length === 0) return;
    element.scrollTop = element.scrollHeight;
  });
</script>

<div
  class="pointer-events-none absolute inset-0"
  bind:clientWidth={viewerWidth}
  bind:clientHeight={viewerHeight}
  data-pane="assistant-chat"
>
  {#if chatAt && assistant.status === "ready"}
    <div
      class="pointer-events-auto absolute z-10 flex flex-col gap-2 rounded-lg border border-line bg-elevated p-2
             text-xs shadow-lg"
      style:left="{chatAt.left}px"
      style:top="{chatAt.top}px"
      style:width="{CHAT_WIDTH}px"
      bind:offsetHeight={chatHeight}
      ondragover={(event) => event.preventDefault()}
      ondrop={onDrop}
      role="region"
      aria-label="Assistant chat"
      data-assistant-chat
      data-target={assistant.target === "photo" ? "photo" : "box"}
    >
      <div class="flex items-center gap-1">
        <div class="min-w-0 flex-1">
          <Select
            value={assistant.settings.harness}
            options={harnessOptions}
            onChange={(value) => void assistant.setHarness(String(value) as HarnessId)}
          />
        </div>
        <div class="min-w-0 flex-1">
          <Select
            value={assistant.settings.model}
            options={modelOptions}
            filter={searchOptions}
            onChange={(value) => void assistant.setModel(String(value))}
          />
        </div>
        <div class="min-w-0 flex-1">
          <Select
            value={assistant.settings.effort}
            options={effortOptions}
            onChange={(value) => void assistant.setEffort(String(value) as Effort | "")}
          />
        </div>
        <Button size="sm" variant="ghost" icon={XIcon} onclick={() => void assistant.closeChat()}
        ></Button>
      </div>

      <div class="flex items-center gap-1 text-2xs text-faint">
        <span class="flex-1">
          {assistant.target === "photo"
            ? "The whole photo"
            : "The selected region — drag again to move it"}
        </span>
        {#if assistant.target !== "photo"}
          <Button
            size="sm"
            variant="ghost"
            icon={FrameCornersIcon}
            onclick={() => assistant.select("photo")}
          >
            Whole photo
          </Button>
        {/if}
      </div>

      {#if assistant.items.length > 0}
        <div
          bind:this={transcript}
          class="flex max-h-60 flex-col gap-1 overflow-y-auto"
          data-assistant-transcript
        >
          {#each assistant.items as item, index (index)}
            {#if item.kind === "user"}
              <div class="flex flex-col items-end gap-1 self-end">
                {#if item.images?.length}
                  <div class="flex gap-1">
                    {#each item.images as image, at (at)}
                      <img
                        src={image}
                        alt="reference {at + 1}"
                        class="size-10 rounded object-cover"
                      />
                    {/each}
                  </div>
                {/if}
                <p class="rounded-md bg-raised px-2 py-1 text-default">{item.text}</p>
              </div>
            {:else if item.kind === "assistant"}
              <p class="whitespace-pre-wrap text-default">{item.text}</p>
            {:else if item.kind === "tool"}
              <p class="truncate font-mono text-2xs text-faint" data-tool-status={item.status}>
                {item.status === "failed" ? "✗" : "·"}
                {item.title}
              </p>
            {:else}
              <p class="text-faint">{item.text}</p>
            {/if}
          {/each}
        </div>
      {/if}

      {#if assistant.pending}
        <div class="flex items-center gap-2 rounded-md bg-raised px-2 py-1" data-assistant-approval>
          <span class="min-w-0 flex-1 truncate">Allow {assistant.pending.title}?</span>
          <Button size="sm" onclick={() => assistant.pending?.decide(true)}>Allow</Button>
          <Button size="sm" variant="ghost" onclick={() => assistant.pending?.decide(false)}
            >Reject</Button
          >
        </div>
      {/if}

      {#if assistant.error}
        <p class="text-red">{assistant.error}</p>
      {/if}

      {#if assistant.references.length > 0}
        <div class="flex gap-1" data-assistant-references>
          {#each assistant.references as reference, at (reference.url)}
            <div class="relative">
              <img
                src={reference.url}
                alt="reference {at + 1}"
                class="size-12 rounded object-cover"
              />
              <button
                class="absolute -top-1 -right-1 rounded-full bg-elevated p-0.5 text-faint hover:text-default"
                aria-label="Remove reference {at + 1}"
                onclick={() => assistant.detach(at)}
              >
                <XIcon size={10} />
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <div class="flex items-end gap-1">
        <textarea
          class="h-14 min-w-0 flex-1 resize-none rounded-md border border-line bg-input px-2 py-1 text-xs
                 text-default outline-none focus:border-line-strong"
          placeholder={assistant.target === "photo"
            ? "What should change in the photo?"
            : "What should change here?"}
          bind:value={instruction}
          onkeydown={onKeyDown}
          onpaste={onPaste}
          data-assistant-input></textarea>
        <input
          bind:this={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onchange={(event) => {
            attach(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={PaperclipIcon}
          disabled={assistant.references.length >= MAX_REFERENCES}
          onclick={() => picker?.click()}
        ></Button>
        {#if assistant.running}
          <Button size="sm" icon={StopIcon} onclick={() => void assistant.stop()}>Stop</Button>
        {:else}
          <Button size="sm" icon={PaperPlaneRightIcon} disabled={!instruction.trim()} onclick={send}
            >Send</Button
          >
        {/if}
      </div>
      <div class="flex items-center gap-2 text-2xs text-faint">
        {#if assistant.running}
          <LoadingSpinner size={10} label="working" />
          <span>working…</span>
        {/if}
        {#if assistant.costUsd !== null}
          <span class="ml-auto">${assistant.costUsd.toFixed(4)}</span>
        {/if}
      </div>
    </div>
  {/if}
</div>
