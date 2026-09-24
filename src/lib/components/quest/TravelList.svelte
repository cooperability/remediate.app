<script lang="ts">
	import type { MapNode } from '$lib/quest/types';

	let {
		nodes,
		current,
		busy,
		ongo
	}: {
		nodes: MapNode[];
		current: string;
		busy: boolean;
		ongo: (node: MapNode) => void;
	} = $props();

	// Everywhere the map shows, as a list: fast travel for keyboards and screen
	// readers, who cannot tap a dot. Halls first, then concepts by size, then cards.
	const ORDER = { deck: 0, tag: 1, concept: 1, card: 2 } as const;
	const SHOWN = 12;

	let query = $state('');
	const places = $derived(
		nodes
			.filter((n) => !n.ghost && n.id !== current)
			.sort(
				(a, b) =>
					ORDER[a.facet] - ORDER[b.facet] ||
					(b.weight ?? 0) - (a.weight ?? 0) ||
					a.title.localeCompare(b.title)
			)
	);
	const hits = $derived(
		query.trim()
			? places.filter((n) => n.title.toLowerCase().includes(query.trim().toLowerCase()))
			: places
	);
</script>

<details class="panel group">
	<summary class="flex min-h-11 cursor-pointer items-center justify-between px-4 select-none">
		<span class="eyebrow">Travel · {places.length} places</span>
		<span class="text-muted transition group-open:rotate-45" aria-hidden="true">+</span>
	</summary>
	<div class="px-4 pb-4">
		<label class="block">
			<span class="sr-only">Find a place</span>
			<input
				class="input min-h-11 text-sm"
				type="search"
				placeholder="Find a place"
				bind:value={query}
			/>
		</label>
		<ul class="mt-2 flex flex-col gap-1">
			{#each hits.slice(0, SHOWN) as n (n.id)}
				<li>
					<button
						class="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
						disabled={busy}
						onclick={() => ongo(n)}
					>
						<span class="min-w-0 flex-1 truncate">{n.title}</span>
						<span class="shrink-0 text-xs text-muted">
							{n.facet === 'deck'
								? 'Hall'
								: n.facet === 'card'
									? n.open
										? 'Known'
										: 'Rematch'
									: 'Tag'}
						</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if hits.length > SHOWN}
			<p class="mt-2 text-xs text-muted">{hits.length - SHOWN} more: type to narrow.</p>
		{:else if !hits.length}
			<p class="mt-2 text-sm text-muted">Nowhere by that name on your map yet.</p>
		{/if}
	</div>
</details>
