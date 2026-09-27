<script lang="ts">
  // The selection chat: in the Assistant rail mode a drag on the photo selects a box, and a
  // chat card floats next to it, following zoom and pan; a click asks about the whole photo,
  // and the card docks at the bottom. The card is DOM over the viewer, not overlay drawing,
  // so it can take text and images; the box itself is overlay drawing.
  import type { OverlayMap, OverlayPointer } from "@latent/contracts";
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, Select, type IconComponent } from "@neoworks-dev/ui";
  import type { Effort, HarnessId } from "@neoworks/harness/client";
  import ArrowUpIcon from "phosphor-svelte/lib/ArrowUpIcon";
  import OpenAiLogoIcon from "phosphor-svelte/lib/OpenAiLogoIcon";
  import PaperclipIcon from "phosphor-svelte/lib/PaperclipIcon";
  import PushPinIcon from "phosphor-svelte/lib/PushPinIcon";
  import SquareIcon from "phosphor-svelte/lib/SquareIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import {
    ASSISTANT_MODE,
    boxFromDrag,
    chatPosition,
    chatWidth,
    dockedPosition,
    EFFORT_LABELS,
    HARNESS_LABELS,
    placedPosition,
    transcriptHeight,
    type Box,
    type ChangeRow,
    type Point,
  } from "./assistant";
  import ClaudeIcon from "./icons/ClaudeIcon.svelte";
  import Markdown from "./Markdown.svelte";
  import ToolCall from "./ToolCall.svelte";
  import TurnSummary from "./TurnSummary.svelte";
  import PiIcon from "./icons/PiIcon.svelte";
  import { MAX_REFERENCES } from "./references";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const assistant = ctx.assistant;
  const viewer = ctx.viewer;

  const HARNESS_ICONS: Record<HarnessId, IconComponent> = {
    claude: ClaudeIcon,
    codex: OpenAiLogoIcon,
    pi: PiIcon,
  };

  let viewerWidth = $state(0);
  let viewerHeight = $state(0);
  let chatHeight = $state(0);
  let instruction = $state("");
  let drag = $state<{ start: Point; current: Point } | null>(null);
  let transcript = $state<HTMLDivElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  let chat = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLTextAreaElement | null>(null);
  let layer = $state<HTMLDivElement | null>(null);
  /** The chat being dragged by its grip: where it is now, and where the pointer took it. */
  let moving = $state<{
    pointerId: number;
    grabX: number;
    grabY: number;
    left: number;
    top: number;
  } | null>(null);

  const view = $derived({ width: viewerWidth, height: viewerHeight });
  const width = $derived(chatWidth(view, ctx.panes.safeArea));
  const transcriptMax = $derived(transcriptHeight(view, ctx.panes.safeArea));

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
    const chat = { width, height: chatHeight };
    const safeArea = ctx.panes.safeArea;
    if (moving) return placedPosition(moving, chat, view, safeArea);
    if (assistant.placement) return placedPosition(assistant.placement, chat, view, safeArea);
    if (assistant.target === "photo") return dockedPosition(chat, view, safeArea);
    return selectionOnScreen && chatPosition(selectionOnScreen, chat, view, safeArea);
  });

  // The grip drags the chat like a floating card: it stays where it is dropped, and the pin
  // (or a double-click on the grip) puts it back next to the selection.
  function onGripDown(event: PointerEvent): void {
    if (event.button !== 0 || !layer || !chatAt) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const origin = layer.getBoundingClientRect();
    moving = {
      pointerId: event.pointerId,
      grabX: event.clientX - origin.left - chatAt.left,
      grabY: event.clientY - origin.top - chatAt.top,
      left: chatAt.left,
      top: chatAt.top,
    };
  }

  function onGripMove(event: PointerEvent): void {
    if (!moving || !layer || event.pointerId !== moving.pointerId) return;
    const origin = layer.getBoundingClientRect();
    moving = {
      ...moving,
      left: event.clientX - origin.left - moving.grabX,
      top: event.clientY - origin.top - moving.grabY,
    };
  }

  function onGripUp(event: PointerEvent): void {
    if (!moving || event.pointerId !== moving.pointerId) return;
    const dropped = chatAt;
    moving = null;
    if (dropped) assistant.place(dropped);
  }

  const harnessOptions = $derived(
    assistant.harnesses.map((harness) => ({
      value: harness.id,
      label: HARNESS_LABELS[harness.id],
      icon: HARNESS_ICONS[harness.id],
    })),
  );
  const modelOptions = $derived([
    { value: "", label: "Default model" },
    ...(assistant.models[assistant.settings.harness] ?? []).map((model) => ({
      value: model.id,
      label: model.name,
      description: model.description,
    })),
  ]);
  const effortOptions = $derived([
    { value: "", label: "Default effort" },
    ...(
      assistant.harnesses.find((harness) => harness.id === assistant.settings.harness)?.efforts ??
      []
    ).map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
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
    // A drag selects a region, a click the whole photo.
    assistant.select(dragged ?? "photo");
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
    following = true;
    void assistant.send(text);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  }

  // Escape stops a running turn, or hides an idle chat, from anywhere but another text field,
  // which takes its own Escape (a slider's typed value cancels). An open Select swallows it
  // before it gets here.
  function onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || !assistant.target) return;
    const target = event.target;
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (field && !chat?.contains(target)) return;
    if (assistant.running) {
      void assistant.stop();
      return;
    }
    assistant.hide();
  }

  /**
   * A change row clicked: the control it moved, flashed in the sidebar. A layer's
   * adjustment is shown the way the Masks flyout shows it — the layer selected, the Edit
   * column aimed at it; a photo-wide one with no layer selected.
   */
  function reveal(row: ChangeRow): void {
    const layer = viewer.stack.find(
      (entry) => entry.id === row.opId || entry.ops?.some((child) => child.id === row.opId),
    );
    // Removed since: there is nothing left to show.
    if (!layer) return;
    ctx.panes.setMode("edit");
    if (layer.op === "group") {
      viewer.selectOp(layer.id);
      viewer.setMaskTarget(layer.id);
      ctx.panes.setRailPane("masks");
    } else if (viewer.maskTarget) {
      ctx.panes.setRailPane(null);
      viewer.setMaskTarget(null);
    }
    ctx.panels.highlight({ opId: row.opId, op: row.op, param: row.param });
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

  $effect(() => {
    void assistant.showPhoto(viewer.photoId);
  });

  // A selection opens the chat to type into: every new one puts the cursor there.
  $effect(() => {
    if (assistant.target) input?.focus();
  });

  // A new selection or a finished chat redraws the box.
  $effect(() => {
    void assistant.target;
    viewer.overlay.redraw();
  });

  // New output keeps the newest line in view only while the reader is at the bottom: once
  // they scroll up to read something, it stays where they put it until they scroll back
  // down or send. A plain field, so the scroll handler does not re-run the effect.
  let following = true;

  function onTranscriptScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    following = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }

  $effect(() => {
    const element = transcript;
    if (!element || assistant.items.length === 0 || !following) return;
    element.scrollTop = element.scrollHeight;
  });
</script>

<svelte:window onkeydown={onWindowKeyDown} />

<div
  class="pointer-events-none absolute inset-0"
  bind:this={layer}
  bind:clientWidth={viewerWidth}
  bind:clientHeight={viewerHeight}
  data-pane="assistant-chat"
>
  {#if chatAt && assistant.status === "ready"}
    <div
      class="pointer-events-auto absolute z-10 flex flex-col gap-2 text-xs"
      style:left="{chatAt.left}px"
      style:top="{chatAt.top}px"
      style:width="{width}px"
      bind:this={chat}
      bind:offsetHeight={chatHeight}
      ondragover={(event) => event.preventDefault()}
      ondrop={onDrop}
      role="region"
      aria-label="Assistant chat"
      data-assistant-chat
      data-target={assistant.target === "photo" ? "photo" : "box"}
      data-running={assistant.running}
      data-placed={assistant.placement !== null}
    >
      <div
        class="flex flex-col rounded-xl border border-line bg-elevated shadow-lg focus-within:border-line-strong"
        class:opacity-80={moving !== null}
        data-assistant-composer
      >
        <!-- The grip. `touch-none` so a drag on a touch screen moves the chat instead of
             scrolling the page. -->
        <div
          class="relative flex h-4 shrink-0 cursor-grab touch-none items-center justify-center"
          class:cursor-grabbing={moving !== null}
          role="presentation"
          title="Drag to move; double-click to put it back by the selection"
          onpointerdown={onGripDown}
          onpointermove={onGripMove}
          onpointerup={onGripUp}
          onpointercancel={onGripUp}
          ondblclick={() => assistant.place(null)}
          data-assistant-grip
        >
          <span class="h-1 w-8 rounded-full bg-line-strong"></span>
          {#if assistant.placement}
            <button
              type="button"
              class="absolute top-0.5 right-2 rounded-sm p-0.5 text-faint transition-colors hover:text-default"
              aria-label="Put the chat back by the selection"
              onpointerdown={(event) => event.stopPropagation()}
              onclick={() => assistant.place(null)}
              data-assistant-unpin
            >
              <PushPinIcon size={11} weight="bold" />
            </button>
          {/if}
        </div>
        <!-- Once there is a conversation the box grows upward to hold it, so replies read
             on the box and not on the photo. -->
        {#if assistant.items.length > 0}
          <div
            bind:this={transcript}
            onscroll={onTranscriptScroll}
            class="flex flex-col gap-2 overflow-y-auto border-b border-line px-3 pb-3"
            style:max-height="{transcriptMax}px"
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
                  <p class="rounded-lg bg-hover px-2.5 py-1.5 text-default">{item.text}</p>
                </div>
              {:else if item.kind === "assistant"}
                <Markdown text={item.text} />
              {:else if item.kind === "tool"}
                <ToolCall {item} onReveal={reveal} />
              {:else if item.kind === "summary"}
                <TurnSummary
                  steps={item.steps}
                  undone={item.undone}
                  onUndo={() => void assistant.undoTurn(item.index)}
                  onReveal={reveal}
                />
              {:else}
                <p class="text-faint">{item.text}</p>
              {/if}
            {/each}
            {#if assistant.waiting}
              <div class="flex items-center gap-2 text-muted" data-assistant-waiting>
                <LoadingSpinner size={12} label="waiting" />
                <span>Waiting for the job to finish — the agent picks up when it is done.</span>
              </div>
            {/if}
          </div>
        {/if}

        {#if assistant.pending}
          <div
            class="mx-3 mt-3 flex items-center gap-2 rounded-md bg-hover px-2 py-1"
            data-assistant-approval
          >
            <span class="min-w-0 flex-1 truncate">Allow {assistant.pending.title}?</span>
            <Button size="sm" onclick={() => assistant.pending?.decide(true)}>Allow</Button>
            <Button size="sm" variant="ghost" onclick={() => assistant.pending?.decide(false)}
              >Reject</Button
            >
          </div>
        {/if}

        {#if assistant.error}
          <p class="px-3 pt-3 text-red">{assistant.error}</p>
        {/if}

        {#if assistant.references.length > 0}
          <div class="flex gap-1 px-3 pt-3" data-assistant-references>
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
        <textarea
          class="h-24 resize-none bg-transparent px-3 pt-3 text-sm text-default outline-none placeholder:text-faint"
          placeholder={assistant.target === "photo"
            ? "What should change in the photo? /clear starts over"
            : "What should change here? /clear starts over"}
          bind:this={input}
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
        <div class="flex items-center gap-1 p-2">
          <Button
            size="sm"
            variant="ghost"
            round
            icon={PaperclipIcon}
            disabled={assistant.references.length >= MAX_REFERENCES}
            onclick={() => picker?.click()}
          ></Button>
          <div class="flex min-w-0 flex-1 items-center" data-assistant-settings>
            <Select
              size="sm"
              variant="ghost"
              value={assistant.settings.harness}
              options={harnessOptions}
              onChange={(value) => void assistant.setHarness(String(value) as HarnessId)}
            />
            <Select
              size="sm"
              variant="ghost"
              value={assistant.settings.model}
              options={modelOptions}
              filter={searchOptions}
              onChange={(value) => void assistant.setModel(String(value))}
            />
            <Select
              size="sm"
              variant="ghost"
              value={assistant.settings.effort}
              options={effortOptions}
              onChange={(value) => void assistant.setEffort(String(value) as Effort | "")}
            />
          </div>
          {#if assistant.costUsd !== null}
            <span class="text-2xs text-faint">${assistant.costUsd.toFixed(4)}</span>
          {/if}
          {#if assistant.running}
            <Button
              size="sm"
              variant="primary"
              round
              icon={SquareIcon}
              onclick={() => void assistant.stop()}
            ></Button>
          {:else}
            <Button
              size="sm"
              variant="primary"
              round
              icon={ArrowUpIcon}
              disabled={!instruction.trim()}
              onclick={send}
            ></Button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
