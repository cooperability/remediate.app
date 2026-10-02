<script lang="ts">
	import { enhance } from '$app/forms';
	import Heatmap from '$lib/components/charts/Heatmap.svelte';
	import DeckCard from '$lib/components/deck/DeckCard.svelte';
	import StatTile from '$lib/components/deck/StatTile.svelte';

	let { data, form } = $props();

	const s = $derived(data.stats);
	const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
	const reviews12w = $derived(s.heatmap.flat().reduce((n, c) => n + (c?.count ?? 0), 0));

	let fileName = $state('');
	let importing = $state(false);
</script>

<svelte:head>
	<title>Decks · Remediate</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-8 sm:py-10">
	<section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		<StatTile
			label="Due now"
			value={s.dueNow}
			hint="{s.cardsTotal} cards in total"
			accent={s.dueNow > 0}
		/>
		<StatTile label="Reviewed today" value={s.reviewedToday} hint="Since midnight, your time" />
		<StatTile
			label="Streak"
			value="{s.streakDays}d"
			hint={s.streakDays ? 'Consecutive days with a review' : 'Review today to start one'}
		/>
		<StatTile
			label="30-day retention"
			value={pct(s.retention30d)}
			hint="{s.reviews30d} reviews of learned cards, anything above Again"
		/>
	</section>

	<section class="panel mt-4 p-5">
		<div class="flex items-baseline justify-between gap-3">
			<h2 class="eyebrow">Reviews, last 12 weeks</h2>
			<span class="text-muted font-mono text-xs">{reviews12w} total</span>
		</div>
		<div class="mt-4 max-w-2xl">
			<Heatmap
				weeks={s.heatmap}
				label="Daily reviews over the last 12 weeks, {reviews12w} in total"
			/>
		</div>
	</section>

	{#if data.deleted}
		<p class="panel mt-4 px-4 py-3 text-sm" role="status">
			Deleted <span class="font-medium">{data.deleted}</span>.
		</p>
	{/if}

	<div class="mt-10 flex items-baseline justify-between">
		<h1 class="text-2xl font-bold tracking-tight">Decks</h1>
		<span class="text-muted font-mono text-xs">{data.decks.length} decks</span>
	</div>

	{#if data.decks.length}
		<section class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.decks as d (d.deck)}
				<DeckCard {...d} />
			{/each}
		</section>
	{:else}
		<section class="panel mt-4 p-10 text-center">
			<p class="text-lg font-semibold">No decks yet</p>
			<p class="text-muted mt-1 text-sm">
				Export a deck from Anki as <span class="font-mono">Notes in Plain Text</span> and drop it below.
			</p>
		</section>
	{/if}

	<form
		method="POST"
		action="?/import"
		enctype="multipart/form-data"
		use:enhance={() => {
			importing = true;
			return async ({ update }) => {
				await update();
				importing = false;
				fileName = '';
			};
		}}
		class="mt-8"
	>
		<label
			class="panel hover:border-accent focus-within:border-accent flex cursor-pointer flex-col items-center gap-2 border-2 border-dashed p-8 text-center transition"
		>
			<span class="eyebrow">Import</span>
			<span class="font-semibold">{fileName || 'Choose an Anki export'}</span>
			<span class="text-muted text-xs"
				>.txt, .tsv or .csv. Re-importing updates cards in place.</span
			>
			<input
				type="file"
				name="file"
				accept=".txt,.tsv,.csv"
				required
				aria-label="Anki export"
				class="sr-only"
				onchange={(e) => (fileName = e.currentTarget.files?.[0]?.name ?? '')}
			/>
		</label>
		<div class="mt-3 flex items-center gap-3">
			<!-- Not gated on fileName: that is empty until hydration, and the input is required. -->
			<button class="btn btn-primary" disabled={importing}>
				{importing ? 'Importing…' : 'Import deck'}
			</button>
			{#if form?.message}
				<p class="text-sm" role="status">
					{form.message}
					{#if 'warnings' in form && form.warnings?.length}
						<span class="text-hard">{form.warnings.length} warnings.</span>
					{/if}
				</p>
			{/if}
		</div>
	</form>
</main>
