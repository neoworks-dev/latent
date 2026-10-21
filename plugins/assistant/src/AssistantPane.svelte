<script lang="ts">
  // The Assistant column: what the mode does, whether the neo daemon is there, and the daemon's
  // sessions: a click shows one in the chat, to read and continue. The chat itself floats over
  // the photo, next to the region it is about.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, SectionHeader, StatusBadge } from "@neoworks-dev/ui";
  import FrameCornersIcon from "phosphor-svelte/lib/FrameCornersIcon";
  import { activityLabel, sessionTitle } from "./assistant";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const assistant = ctx.assistant;
  const viewer = ctx.viewer;

  // The time of the last activity is relative, so it moves on while nothing else changes.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** The session the chat is on, once there is a chat. */
  const shown = $derived(assistant.target === null ? null : assistant.shownSession);
</script>

<div
  class="flex flex-col gap-2 px-3 pb-3 text-xs"
  data-pane="assistant"
  data-status={assistant.status}
  data-open-photo={viewer.photoId ?? undefined}
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
    <div data-assistant-sessions>
      <SectionHeader title="Sessions" />
      <!-- Every session the daemon has ever had: the list scrolls, newest first. -->
      <div class="flex max-h-80 flex-col overflow-y-auto">
        {#each assistant.sessions as session (session.id)}
          <button
            type="button"
            class="flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-1.5 py-1 text-left text-muted
                 hover:bg-hover hover:text-default"
            class:bg-raised={session.id === shown}
            class:text-default={session.id === shown}
            data-session={session.id}
            data-session-state={session.state}
            onclick={() => assistant.viewSession(session.id)}
          >
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate">{sessionTitle(session)}</span>
              {#if session.id === assistant.photoSession}
                <StatusBadge tone="blue">This photo</StatusBadge>
              {/if}
              <span class="ml-auto shrink-0">
                <StatusBadge tone={session.state === "running" ? "amber" : "neutral"}
                  >{session.state}</StatusBadge
                >
              </span>
            </span>
            <span class="text-faint">{activityLabel(session.lastActivity, now)}</span>
          </button>
        {:else}
          <p class="px-1.5 text-faint">No sessions yet.</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
