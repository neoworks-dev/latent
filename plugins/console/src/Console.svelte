<script lang="ts">
  // The Python console pane, in the right column. A scrollback of run blocks over a
  // textarea, with a drag handle between them — none of which the design system has; the
  // frame around them (Button, LoadingSpinner, Tooltip) is its. The card's title bar, its
  // fold and its Clear belong to the shell and to `ConsoleActions`.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, Tooltip } from "@neoworks-dev/ui";
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
    // The handle is under the scrollback now, so dragging down makes it taller.
    pythonConsole.setHeight(dragFrom.height + (event.clientY - dragFrom.y));
  }

  function endDrag(): void {
    dragFrom = null;
  }

  function resizeByKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    pythonConsole.setHeight(pythonConsole.height + (event.key === "ArrowDown" ? 24 : -24));
  }

  // Newest output first in view: scroll on every appended line, streamed ones included.
  $effect(() => {
    const element = scrollback;
    if (!element || pythonConsole.lines.length + pythonConsole.streamed.length === 0) return;
    element.scrollTop = element.scrollHeight;
  });
</script>

<div
  class="flex flex-col px-3 pb-2"
  data-pane="console"
  data-console-streamed={pythonConsole.streamedCount}
  data-console-height={pythonConsole.height}
>
  <div
    bind:this={scrollback}
    class="min-h-0 overflow-y-auto rounded-md border border-line bg-canvas px-2 py-1 font-mono
           text-2xs leading-5"
    style:height="{pythonConsole.height}px"
    data-console-scrollback
  >
    <p class="pb-1 text-faint">
      {#each helpExamples as example (example)}
        <span class="mr-2 break-all">{example}</span>
      {/each}
    </p>
    <!-- One block per run, with a bar down its left edge. -->
    {#each runs as run, index (index)}
      <div class="mb-1 border-l-2 border-line-strong pl-2" data-console-run>
        {#if run.code}
          <pre class="whitespace-pre-wrap text-muted" data-line="code">&gt;&gt;&gt; {run.code}</pre>
        {/if}
        {#each run.output as line, lineIndex (lineIndex)}
          <pre
            class="whitespace-pre-wrap {toneClass[line.kind]}"
            data-line={line.kind}>{line.text}</pre>
        {/each}
      </div>
    {/each}
    <!-- Live output of the run still in flight, closed by python.finished's timing line;
         both are replaced by the result's streams when the call returns. -->
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

  <!-- The scrollback's bottom edge is its resize handle; arrows resize it from the
       keyboard. A button, not a separator: a focusable separator is what this is, but
       Svelte's a11y pass calls that a non-interactive element with listeners on it. -->
  <button
    type="button"
    class="my-1 h-1 w-full cursor-row-resize rounded-full bg-transparent hover:bg-action/40"
    aria-label="Resize console"
    data-console-resize
    onpointerdown={startDrag}
    onpointermove={drag}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onkeydown={resizeByKey}
  ></button>

  <textarea
    class="h-20 resize-none rounded-md border border-line bg-input px-2 py-1 font-mono text-2xs
           text-default outline-none focus:border-line-strong"
    spellcheck="false"
    bind:value={code}
    onkeydown={onKeyDown}
    data-console-input
    data-console-history={pythonConsole.history.length}></textarea>
  <div class="flex items-center gap-2 pt-1 text-2xs text-dim">
    {#if pythonConsole.running}
      <span class="flex items-center gap-1" data-console-busy>
        <LoadingSpinner size={11} label="running" />
        running…
      </span>
    {:else}
      <span class="truncate">photo {viewer.photoId ?? "—"}</span>
    {/if}
    <span class="ml-auto shrink-0">↑↓ history</span>
    <Tooltip text="Run the script — Ctrl+Enter" placement="top">
      <Button size="sm" icon={PlayIcon} onclick={() => void pythonConsole.run(code)}>Run</Button>
    </Tooltip>
  </div>
</div>
