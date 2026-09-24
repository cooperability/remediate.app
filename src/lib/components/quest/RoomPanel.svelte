<script lang="ts">
	import { percent, reopens } from '$lib/quest/format';
	import { VIA_LABEL, type Door, type Room } from '$lib/quest/types';

	let {
		room,
		busy,
		now,
		ondoor
	}: { room: Room; busy: boolean; now: Date; ondoor: (door: Door) => void } = $props();

	const FACET_NAME = { deck: 'Deck hall', tag: 'Tag', concept: 'Concept', card: 'Card' } as const;
	const COLLAPSED = 8;

	// The page remounts this panel per room ({#key}), so these start fresh in each.
	let filter = $state('');
	let expanded = $state<Record<string, boolean>>({});
	let showCard = $state(true);

	const matches = (d: Door) =>
		!filter.trim() || d.title.toLowerCase().includes(filter.trim().toLowerCase());

	const groups = $derived.by(() => {
		const doors = room.doors.filter(matches);
		const cards = doors.filter((d) => d.facet === 'card');
		// What to do first, first: reviews and encounters, then the corridors onward.
		return [
			{
				key: 'due',
				title: 'Due for review',
				hint: 'Known, and fading. Recall to keep the door open.',
				doors: cards.filter((d) => d.status === 'open' && d.due)
			},
			{
				key: 'locked',
				title: 'Locked',
				hint: 'Recall the card to open the door.',
				doors: doors.filter((d) => d.status === 'locked')
			},
			{
				key: 'passages',
				title: 'Passages',
				hint: 'Decks and tags.',
				doors: doors.filter((d) => d.facet !== 'card')
			},
			{
				key: 'open',
				title: 'Open',
				hint: 'Cards you know. Walk right in.',
				doors: cards.filter((d) => d.status === 'open' && !d.due)
			},
			{
				key: 'sealed',
				title: 'Sealed',
				hint: 'Not yet: see each door for when.',
				doors: doors.filter((d) => d.status === 'sealed')
			}
		].filter((g) => g.doors.length);
	});

	/** The edge the door follows, read from this room: a prerequisite leads out, or is built on. */
	const via = (d: Door) =>
		d.via === 'prereq_of' && !d.out ? VIA_LABEL['prereq_of:in'] : (VIA_LABEL[d.via] ?? d.via);

	function note(d: Door): string {
		if (d.facet !== 'card') {
			if (d.status === 'sealed') return `Learn first: ${d.needs?.join(', ')}`;
			return FACET_NAME[d.facet];
		}
		if (d.status === 'open') return d.due ? 'Due · recall to keep it open' : `Known · ${via(d)}`;
		if (d.status === 'locked') return d.fresh ? 'New card · recall to enter' : 'Missed · rematch';
		if (d.reason === 'prereq') return `Learn first: ${d.needs?.join(', ')}`;
		if (d.reason === 'new-cap') return 'New cards: back tomorrow';
		return `Opens ${reopens(d.retryAt ?? '', now)}`;
	}
</script>

<section class="flex flex-col gap-5" aria-labelledby="room-title">
	<header>
		<p class="eyebrow">{FACET_NAME[room.facet]}{room.deck ? ` · ${room.deck}` : ''}</p>
		<h1
			id="room-title"
			tabindex="-1"
			class="mt-1 text-xl leading-snug font-bold tracking-tight break-words focus:outline-none"
		>
			{room.title}
		</h1>
		{#if room.progress}
			{@const p = room.progress}
			<div class="mt-3 flex items-center gap-3">
				<div
					class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
					role="progressbar"
					aria-label="Cards known here"
					aria-valuemin={0}
					aria-valuemax={p.total}
					aria-valuenow={p.known}
				>
					<div
						class="h-full rounded-full bg-good transition-[width] duration-500"
						style="width: {p.total ? (p.known / p.total) * 100 : 0}%"
					></div>
				</div>
				<span class="font-mono text-xs text-muted tabular-nums">{p.known} / {p.total} known</span>
			</div>
		{:else if room.facet === 'card'}
			<p class="mt-2 text-sm text-muted">
				Recall now <span class="font-mono text-fg tabular-nums">{percent(room.strength)}</span>
			</p>
		{/if}
	</header>

	{#if room.facet === 'card' && room.front !== undefined}
		<div class="panel px-4 pb-4">
			<button
				class="flex min-h-11 w-full items-center justify-between text-left"
				aria-expanded={showCard}
				onclick={() => (showCard = !showCard)}
			>
				<span class="eyebrow">The card</span>
				<span class="text-muted" aria-hidden="true">{showCard ? '−' : '+'}</span>
			</button>
			{#if showCard}
				<!-- Card HTML is DOMPurify-sanitized at import (ingest/sanitize.ts) before it is stored. -->
				<div class="card-html prose prose-sm max-h-48 max-w-none overflow-y-auto dark:prose-invert">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html room.front}
				</div>
				<div
					class="card-html prose prose-sm mt-3 max-h-64 max-w-none overflow-y-auto border-t border-line pt-3 dark:prose-invert"
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html room.back}
				</div>
				{#if room.tags?.length}
					<div class="mt-3 flex flex-wrap gap-1.5">
						{#each room.tags as tag (tag)}<span class="chip">{tag}</span>{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	{#if room.doors.length > COLLAPSED}
		<label class="block">
			<span class="sr-only">Filter doors</span>
			<input
				class="input min-h-11 text-sm"
				type="search"
				placeholder="Filter {room.doors.length} doors"
				bind:value={filter}
			/>
		</label>
	{/if}

	{#each groups as g (g.key)}
		{@const open = expanded[g.key] || g.doors.length <= COLLAPSED + 2}
		<div>
			<div class="flex items-baseline justify-between gap-3">
				<h2 class="eyebrow">{g.title} <span class="tabular-nums">· {g.doors.length}</span></h2>
				<span class="hidden text-xs text-muted sm:inline">{g.hint}</span>
			</div>
			<ul class="mt-2 flex flex-col gap-1.5">
				{#each open ? g.doors : g.doors.slice(0, COLLAPSED) as d (d.to)}
					<li>
						<button
							class="door status-{d.status}"
							class:due={d.due}
							disabled={busy || d.status === 'sealed'}
							onclick={() => ondoor(d)}
							data-door={d.to}
						>
							<span class="icon" aria-hidden="true">
								{#if d.facet !== 'card'}
									<svg viewBox="0 0 16 16"><path d="M3 8h9M9 4l4 4-4 4" /></svg>
								{:else if d.status === 'open' && d.due}
									<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" /></svg
									>
								{:else if d.status === 'open'}
									<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" /></svg>
								{:else if d.status === 'locked'}
									<svg viewBox="0 0 16 16"
										><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path
											d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
										/></svg
									>
								{:else}
									<svg viewBox="0 0 16 16"
										><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg
									>
								{/if}
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate">{d.title}</span>
								<span class="block truncate text-xs text-muted">{note(d)}</span>
							</span>
							{#if d.status === 'locked'}
								<span class="chip shrink-0 border-accent/40 bg-accent-soft text-fg">Recall</span>
							{:else if d.due}
								<span class="chip shrink-0 border-hard/40 bg-hard/10 text-fg">Review</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
			{#if !open}
				<button
					class="btn btn-ghost mt-1 min-h-11 w-full text-muted"
					onclick={() => (expanded = { ...expanded, [g.key]: true })}
				>
					Show all {g.doors.length}
				</button>
			{/if}
		</div>
	{:else}
		<p class="text-sm text-muted">
			{filter ? 'No door matches that filter.' : 'No doors lead out of here yet.'}
		</p>
	{/each}
</section>

<style>
	.door {
		display: flex;
		width: 100%;
		min-height: 44px;
		align-items: center;
		gap: 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--line);
		background: var(--surface);
		padding: 0.5rem 0.75rem;
		text-align: left;
		font-size: 0.875rem;
		transition:
			background 0.15s,
			border-color 0.15s,
			transform 0.1s;
	}
	.door:hover:not(:disabled) {
		background: var(--surface-2);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
	}
	.door:active:not(:disabled) {
		transform: scale(0.99);
	}
	.door:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.icon {
		display: inline-flex;
		height: 1.75rem;
		width: 1.75rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		background: var(--surface-2);
	}
	.icon svg {
		height: 1rem;
		width: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.status-open .icon {
		color: var(--good);
	}
	.status-open:not(.due) .icon circle {
		fill: currentColor;
	}
	.status-open.due .icon {
		color: var(--hard);
	}
	.status-locked .icon {
		color: var(--accent);
	}
	.status-sealed .icon {
		color: var(--muted);
	}
	.card-html {
		color: var(--fg);
		overflow-wrap: anywhere;
	}
	.card-html :global(img) {
		max-width: 100%;
		height: auto;
	}
	.card-html :global(code::before),
	.card-html :global(code::after) {
		content: none;
	}
</style>
