<script lang="ts">
  // An agent's reply, drawn from `parseMarkdown`'s nodes as plain elements — never `{@html}`.
  import { parseMarkdown, type MarkdownNode } from "./markdown";

  const { text }: { text: string } = $props();
  const nodes = $derived(parseMarkdown(text));
</script>

{#snippet render(parts: MarkdownNode[])}
  {#each parts as node, index (index)}
    {#if node.kind === "text"}
      {node.text}
    {:else if node.kind === "paragraph"}
      <p class="whitespace-pre-wrap">{@render render(node.children)}</p>
    {:else if node.kind === "heading"}
      <p class="font-semibold" class:text-sm={node.level === 1}>{@render render(node.children)}</p>
    {:else if node.kind === "strong"}
      <strong class="font-semibold">{@render render(node.children)}</strong>
    {:else if node.kind === "em"}
      <em>{@render render(node.children)}</em>
    {:else if node.kind === "del"}
      <del>{@render render(node.children)}</del>
    {:else if node.kind === "codespan"}
      <code class="rounded-sm bg-hover px-1 font-mono text-2xs">{node.text}</code>
    {:else if node.kind === "code"}
      <pre
        class="overflow-x-auto rounded-md bg-input p-2 font-mono text-2xs whitespace-pre text-muted">{node.text}</pre>
    {:else if node.kind === "list"}
      <svelte:element
        this={node.ordered ? "ol" : "ul"}
        class="flex flex-col gap-0.5 pl-4"
        class:list-decimal={node.ordered}
        class:list-disc={!node.ordered}
      >
        {@render render(node.children)}
      </svelte:element>
    {:else if node.kind === "item"}
      <li>{@render render(node.children)}</li>
    {:else if node.kind === "blockquote"}
      <blockquote class="border-l-2 border-line-strong pl-2 text-muted">
        {@render render(node.children)}
      </blockquote>
    {:else if node.kind === "break"}
      <br />
    {:else}
      <hr class="border-line" />
    {/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-1.5 text-default" data-markdown>
  {@render render(nodes)}
</div>
