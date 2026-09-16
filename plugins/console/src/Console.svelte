<script lang="ts">
  // The Python console pane. A textarea, a scrollback of run blocks, and a drag handle on
  // its top edge — none of which the design system has; the frame around them (Button,
  // StatusBadge, LoadingSpinner, Tooltip) is its.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretUpIcon from "phosphor-svelte/lib/CaretUpIcon";
  import PlayIcon from "phosphor-svelte/lib/PlayIcon";
  import { caretPosition, groupRuns, helpExamples, recallDirection, runsScript } from "./console";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const pythonConsole = ctx.console;
  const viewer = ctx.viewer;

  let code = $state("latent.photo.develop.exposure = 0.7");
  let scrollback = $state<HTMLDivElement | null>(null);
  let dragFrom: { y: number; height: number } | null = null;

  const runs = $derived(groupRuns(pythonConsole.lines));
  const toneClass: Record<string, string> = {
    code: "text-muted",
    stdout: "text-default",
    stderr: "text-red",
    value: "text-blue",
    note: "text-faint",
  };

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (runsScript(event)) {
      event.preventDefault();
      void pythonConsole.run(code);
      return;
    }
    const direction = recallDirection(
      event,
      caretPosition(code, target.selectionStart, target.selectionEnd),
    );
    if (direction === null) return;
    event.preventDefault();
    code = pythonConsole.recall(direction);
  }

  function startDrag(event: PointerEvent): void {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    handle.setPointerCapture(event.pointerId);
    dragFrom = { y: event.clientY, height: pythonConsole.height };
  }

  function drag(event: PointerEvent): void {
    if (!dragFrom) return;
    pythonConsole.setHeight(dragFrom.height + (dragFrom.y - event.clientY));
  }

  function endDrag(): void {
    dragFrom = null;
  }

  function resizeByKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    pythonConsole.setHeight(pythonConsole.height + (event.key === "ArrowUp" ? 24 : -24));
  }

  // Newest output first in view: scroll on every appended line, streamed ones included.
  $effect(() => {
    const element = scrollback;
    if (!element || pythonConsole.lines.length + pythonConsole.streamed.length === 0) return;
    element.scrollTop = element.scrollHeight;
  });
</script>

<div
  class="flex flex-col border-t border-line bg-elevated"
  data-pane="console"
  data-console-streamed={pythonConsole.streamedCount}
  data-console-height={pythonConsole.height}
>
  {#if pythonConsole.visible}
    <!-- The pane's top edge is its resize handle; arrows resize it from the keyboard. A
         button, not a separator: a focusable separator is what this is, but Svelte's a11y
         pass calls that a non-interactive element with listeners on it. -->
    <button
      type="button"
      class="h-1 w-full cursor-row-resize bg-transparent hover:bg-action/40"
      aria-label="Resize console"
      data-console-resize
      onpointerdown={startDrag}
      onpointermove={drag}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      onkeydown={resizeByKey}
    ></button>
  {/if}

  <div class="flex items-center gap-2 px-3 py-1 text-xs">
    <span class="font-semibold text-default">Python</span>
    <StatusBadge tone="neutral">Ctrl+`</StatusBadge>
    {#if pythonConsole.running}
      <span class="flex items-center gap-1 text-dim" data-console-busy>
        <LoadingSpinner size={11} label="running" />
        running…
      </span>
    {/if}
    <span class="ml-auto flex items-center gap-1">
      {#if pythonConsole.visible}
        <Tooltip text="Clear scrollback — Ctrl+L" placement="top">
          <Button size="sm" variant="ghost" onclick={() => pythonConsole.clear()}>Clear</Button>
        </Tooltip>
      {/if}
      <Tooltip text="Toggle the console — Ctrl+`" placement="top">
        <Button
          size="sm"
          variant="ghost"
          icon={pythonConsole.visible ? CaretDownIcon : CaretUpIcon}
          onclick={() => pythonConsole.toggle()}
        >
          {pythonConsole.visible ? "Hide" : "Show"}
        </Button>
      </Tooltip>
    </span>
  </div>

  {#if pythonConsole.visible}
    <div class="flex min-h-0" style:height="{pythonConsole.height}px">
      <div
        bind:this={scrollback}
        class="min-w-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-2xs leading-5"
        data-console-scrollback
      >
        <p class="pb-1 text-faint">
          {#each helpExamples as example (example)}
            <span class="mr-3 whitespace-nowrap">{example}</span>
          {/each}
        </p>
        <!-- One block per run, with a bar down its left edge. -->
        {#each runs as run, index (index)}
          <div class="mb-1 border-l-2 border-line-strong pl-2" data-console-run>
            {#if run.code}
              <pre
                class="whitespace-pre-wrap text-muted"
                data-line="code">&gt;&gt;&gt; {run.code}</pre>
            {/if}
            {#each run.output as line, lineIndex (lineIndex)}
              <pre
                class="whitespace-pre-wrap {toneClass[line.kind]}"
                data-line={line.kind}>{line.text}</pre>
            {/each}
          </div>
        {/each}
        <!-- Live output of the run still in flight, closed by python.finished's timing
             line; both are replaced by the result's streams when the call returns. -->
        {#if pythonConsole.streamed.length > 0 || pythonConsole.finishedNote}
          <div class="mb-1 border-l-2 border-action/60 pl-2">
            {#each pythonConsole.streamed as line, index (index)}
              <pre
                class="whitespace-pre-wrap {toneClass[line.kind]}"
                data-line={line.kind}
                data-streamed>{line.text}</pre>
            {/each}
            {#if pythonConsole.finishedNote}
              <pre
                class="whitespace-pre-wrap {toneClass.note}"
                data-line="note"
                data-streamed>{pythonConsole.finishedNote.text}</pre>
            {/if}
          </div>
        {/if}
      </div>
      <div class="flex w-[46%] flex-col gap-1 border-l border-line px-3 py-2">
        <textarea
          class="min-h-0 flex-1 resize-none rounded-md border border-line bg-input px-2 py-1
                 font-mono text-2xs text-default outline-none focus:border-line-strong"
          spellcheck="false"
          bind:value={code}
          onkeydown={onKeyDown}
          data-console-input
          data-console-history={pythonConsole.history.length}></textarea>
        <div class="flex items-center gap-2 text-2xs text-dim">
          <span>photo {viewer.photoId ?? "—"}</span>
          <span class="ml-auto">↑↓ history · Ctrl+Enter runs</span>
          <Tooltip text="Run the script — Ctrl+Enter" placement="top">
            <Button size="sm" icon={PlayIcon} onclick={() => void pythonConsole.run(code)}>
              Run
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  {/if}
</div>
