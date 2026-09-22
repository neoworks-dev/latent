<script lang="ts">
  // One catalog cell, shared by the filmstrip and the grid: the thumbnail letterboxed on
  // a dark tile, the engine's rating and flag on it, and — on hover — the controls that
  // write them. Hand-built: the design system has no image tile, and its smallest Button
  // is 36 px tall, which does not fit a 100 px cell with five stars on it.
  //
  // Every control here is an engine write for this one photo; the same RPCs the keyboard
  // shortcuts use. Nothing is stored locally, so a cell only changes once `catalog.changed`
  // has been re-listed.
  import type { CatalogPhoto } from "@latent/protocol";
  import { kernelContext } from "@latent/contracts";
  import FlagPennantIcon from "phosphor-svelte/lib/FlagPennantIcon";
  import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
  import ProhibitIcon from "phosphor-svelte/lib/ProhibitIcon";
  import StarIcon from "phosphor-svelte/lib/StarIcon";

  const {
    photo,
    url,
    selected,
    open,
    cellClass = "",
    cellStyle = "",
    onselect,
    onactivate,
  }: {
    photo: CatalogPhoto;
    /** Object URL of the LTHM thumbnail; absent while the engine is still rendering it. */
    url: string | undefined;
    selected: boolean;
    /** The photo the viewer currently has open. */
    open: boolean;
    cellClass?: string;
    /** Inline size for a cell the caller measured: the grid's justified rows. */
    cellStyle?: string;
    onselect: (event: MouseEvent) => void;
    onactivate: () => void;
  } = $props();

  const catalog = kernelContext().catalog;
  const stars = [1, 2, 3, 4, 5];
  const caption = $derived(`${photo.filename} · ${photo.camera}`);

  /** Clicking the star that is already the rating clears it, the way Lightroom does. */
  function rate(star: number): void {
    void catalog.rate(photo.photoId, photo.rating === star ? 0 : star);
  }

  function flag(next: "pick" | "reject"): void {
    void catalog.flagPhoto(photo.photoId, photo.flag === next ? "none" : next);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onactivate();
  }
</script>

<div
  class="group relative overflow-hidden rounded-md border bg-raised outline-none
         transition-colors duration-fast {cellClass}"
  style={cellStyle}
  class:border-line-faint={!selected && !open}
  class:border-line-strong={open && !selected}
  class:border-action={selected}
  class:shadow-md={selected}
  role="option"
  aria-selected={selected}
  aria-label={caption}
  tabindex="-1"
  title={caption}
  data-photo-id={photo.photoId}
  data-rating={photo.rating}
  data-flag={photo.flag}
  data-edited={photo.editedAt !== undefined}
  onclick={onselect}
  ondblclick={onactivate}
  onkeydown={onKeyDown}
>
  {#if url}
    <img src={url} alt={photo.filename} class="h-full w-full object-contain" />
  {:else}
    <span class="flex h-full w-full items-center justify-center text-2xs text-faint">…</span>
  {/if}

  {#if photo.editedAt !== undefined}
    <span
      class="absolute top-1 right-1 rounded-sm bg-black/60 p-0.5 text-blue"
      title="Edited {photo.editedAt}"
      data-edited-badge
    >
      <PencilSimpleIcon size={10} weight="fill" />
    </span>
  {/if}

  <!-- Resting state: only what the engine has on the row, and only if it has anything. -->
  {#if photo.rating > 0 || photo.flag !== "none"}
    <span
      class="absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-black/55 px-1 py-0.5
             group-hover:hidden"
    >
      {#each Array.from({ length: photo.rating }) as _star, index (index)}
        <StarIcon size={10} weight="fill" class="text-amber" />
      {/each}
      {#if photo.flag === "pick"}
        <FlagPennantIcon size={11} weight="fill" class="ml-auto text-green" />
      {/if}
      {#if photo.flag === "reject"}
        <ProhibitIcon size={11} weight="bold" class="ml-auto text-red" />
      {/if}
    </span>
  {/if}

  <!-- Hover: the controls themselves, five stars and the two flags. -->
  <div
    class="absolute inset-x-0 bottom-0 hidden items-center gap-px bg-black/70 px-1 py-1
           group-hover:flex"
    data-cell-controls
  >
    {#each stars as star (star)}
      <button
        type="button"
        class="rounded-sm p-0.5 text-faint hover:bg-white/15 hover:text-amber"
        class:text-amber={star <= photo.rating}
        title="Rate {star}"
        data-rate={star}
        onclick={(event) => {
          event.stopPropagation();
          rate(star);
        }}
      >
        <StarIcon size={11} weight={star <= photo.rating ? "fill" : "regular"} />
      </button>
    {/each}
    <button
      type="button"
      class="ml-auto rounded-sm p-0.5 text-faint hover:bg-white/15 hover:text-green"
      class:text-green={photo.flag === "pick"}
      title="Pick — P"
      data-flag-set="pick"
      onclick={(event) => {
        event.stopPropagation();
        flag("pick");
      }}
    >
      <FlagPennantIcon size={12} weight="fill" />
    </button>
    <button
      type="button"
      class="rounded-sm p-0.5 text-faint hover:bg-white/15 hover:text-red"
      class:text-red={photo.flag === "reject"}
      title="Reject — X"
      data-flag-set="reject"
      onclick={(event) => {
        event.stopPropagation();
        flag("reject");
      }}
    >
      <ProhibitIcon size={12} weight="bold" />
    </button>
  </div>
</div>
