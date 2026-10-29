<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Heatmap from '$lib/components/charts/Heatmap.svelte';
	import DeckCard from '$lib/components/deck/DeckCard.svelte';
	import StatTile from '$lib/components/deck/StatTile.svelte';
	import StudyLink from '$lib/components/deck/StudyLink.svelte';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import Link from '@lucide/svelte/icons/link';
	import MapIcon from '@lucide/svelte/icons/map';
	import Play from '@lucide/svelte/icons/play';
	import Plus from '@lucide/svelte/icons/plus';
	import Upload from '@lucide/svelte/icons/upload';

	let { data, form } = $props();

	const s = $derived(data.stats);
	const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
	const reviews12w = $derived(s.heatmap.flat().reduce((n, c) => n + (c?.count ?? 0), 0));

	// Where a round should start: the most due, else the most unseen.
	const upNext = $derived(
		[...data.decks].sort((a, b) => b.due - a.due || b.fresh - a.fresh).find((d) => d.due || d.fresh)
	);

	let fileName = $state('');
	let importing = $state(false);
</script>

<svelte:head>
	<title>Decks · Remediate</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-6 sm:py-10">
	{#if data.decks.length}
		<section
			class="hero panel relative mb-4 flex flex-col gap-5 overflow-hidden p-5 sm:flex-row sm:items-center sm:p-6"
		>
			<div class="min-w-0 flex-1">
				<p class="eyebrow">Up next</p>
				{#if s.dueNow > 0}
					<p class="mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">
						{s.dueNow} card{s.dueNow === 1 ? '' : 's'} due
					</p>
					<p class="text-muted mt-1 text-sm break-words">
						{#if upNext}Start with <span class="text-fg font-medium">{upNext.deck}</span>,
							{upNext.due} due.{/if}
						{#if s.streakDays}Keep the {s.streakDays}-day streak going.{/if}
					</p>
				{:else}
					<p class="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
						<CheckCheck class="text-good size-7 shrink-0" /> All caught up
					</p>
					<p class="text-muted mt-1 text-sm break-words">
						{#if upNext}
							Nothing is due. Start a round in
							<span class="text-fg font-medium">{upNext.deck}</span>, or wander the map.
						{:else}
							Nothing is due. Wander the map while it holds.
						{/if}
					</p>
				{/if}
			</div>
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				{#if upNext}
					<StudyLink deck={upNext.deck} class="btn btn-primary min-h-12 px-6 text-base">
						<Play class="size-4 fill-current" /> Study <span class="sr-only">{upNext.deck}</span>
					</StudyLink>
				{/if}
				<a
					href={resolve('/quest')}
					class="btn min-h-12 px-5 text-base {upNext ? '' : 'btn-primary'}"
				>
					<MapIcon class="size-4" /> Quest
				</a>
			</div>
		</section>
	{/if}

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

	<div class="mt-10 flex flex-wrap items-center justify-between gap-3">
		<h1 class="flex items-baseline gap-3 text-2xl font-bold tracking-tight">
			Decks <span class="text-muted font-mono text-xs font-normal">{data.decks.length}</span>
		</h1>
		<div class="flex items-center gap-1 sm:gap-2">
			{#if !data.user?.guest}
				<a href={resolve('/harvest')} class="btn btn-ghost text-muted min-h-11 sm:min-h-0">
					<Link class="size-4" /> Harvest links
				</a>
			{/if}
			<a href="{resolve('/cards/browse')}?new=1" class="btn min-h-11 sm:min-h-0">
				<Plus class="size-4" /> New card
			</a>
		</div>
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

	{#if !data.user?.guest}
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
				<span
					class="bg-surface-2 text-muted grid size-11 place-items-center rounded-full"
					aria-hidden="true"><Upload class="size-5" /></span
				>
				<span class="eyebrow">Import</span>
				<span class="font-semibold break-all">{fileName || 'Choose an Anki export'}</span>
				<span class="text-muted text-xs"
					>.txt, .tsv or .csv. Re-importing updates cards in place, except ones edited here.</span
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
	{/if}
</main>

<style>
	/* A soft accent wash, so the next action reads first. */
	.hero {
		background:
			radial-gradient(120% 140% at 100% 0%, var(--accent-soft), transparent 60%), var(--surface);
		border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
	}
</style>
