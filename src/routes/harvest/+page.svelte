<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data, form } = $props();

	const TABS = [
		{ status: 'ready', label: 'To review' },
		{ status: 'queued', label: 'Queued' },
		{ status: 'failed', label: 'Failed' },
		{ status: 'duplicate', label: 'Duplicates' },
		{ status: 'accepted', label: 'Added' },
		{ status: 'discarded', label: 'Discarded' }
	] as const;
	const TIER_CHIP: Record<string, string> = {
		full: 'border-good/40 text-good',
		metadata: 'border-hard/40 text-hard',
		failed: 'border-again/40 text-again'
	};

	const query = (status: string, page = 1) => `status=${status}${page > 1 ? `&page=${page}` : ''}`;

	let selected = $state<string[]>([]);
	// A new list (tab, page, or an action's reload) starts with nothing selected.
	$effect.pre(() => {
		void data.items;
		selected = [];
	});
	const allIds = $derived(data.items.map((i) => i.id));
	const allSelected = $derived(allIds.length > 0 && allIds.every((id) => selected.includes(id)));

	let busy = $state<string | null>(null);
	let fetching = $state(false);
	let stop = $state(false);
	let fetchForm = $state<HTMLFormElement>();

	// Queue, then keep fetching in the background of this page until the queue is
	// empty or the reader stops it. Each round trip fetches a few URLs within the
	// function's time budget.
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			return async ({ result, update }) => {
				await update({ reset: name === 'queue' || name === 'csv' });
				busy = null;
				const d = result.type === 'success' ? result.data : undefined;
				if (d?.autoFetch) {
					stop = false;
					fetchForm?.requestSubmit();
				}
			};
		};
	const trackFetch: SubmitFunction = () => {
		fetching = true;
		return async ({ result, update }) => {
			await update();
			const remaining = result.type === 'success' ? Number(result.data?.remaining ?? 0) : 0;
			if (remaining > 0 && !stop) fetchForm?.requestSubmit();
			else fetching = false;
		};
	};
</script>

<svelte:head>
	<title>Harvest · Remediate</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-8 sm:py-10">
	<a href={resolve('/cards')} class="text-muted hover:text-fg text-sm">← Decks</a>
	<header class="mt-3">
		<p class="eyebrow">BMX</p>
		<h1 class="mt-1 text-3xl font-bold tracking-tight">Harvest links</h1>
		<p class="text-muted mt-2 max-w-2xl text-sm">
			Paste links or a bookmarks export. Each page is fetched, read and held here for you to turn
			into cards. Paywalled pages still land with their title and description.
		</p>
	</header>

	<div class="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
		<form
			method="POST"
			action="?/queue"
			use:enhance={track('queue')}
			class="panel flex flex-col gap-3 p-5"
		>
			<label for="urls" class="eyebrow">Links</label>
			<textarea
				id="urls"
				name="urls"
				rows="5"
				required
				placeholder="One link per line, or paste anything that contains links"
				class="input font-mono text-xs"></textarea>
			<div class="flex items-center gap-3">
				<button class="btn btn-primary whitespace-nowrap" disabled={busy !== null}>
					{busy === 'queue' ? 'Queueing…' : 'Queue links'}
				</button>
				<span class="text-muted text-xs">Up to 500 at a time. Duplicates are skipped.</span>
			</div>
		</form>

		<form
			method="POST"
			action="?/csv"
			enctype="multipart/form-data"
			use:enhance={track('csv')}
			class="panel flex flex-col gap-3 p-5"
		>
			<label for="csv" class="eyebrow">Saved bookmarks</label>
			<p class="text-muted text-xs">
				A CSV with <span class="font-mono">url</span>, <span class="font-mono">title</span> and
				<span class="font-mono">description</span> columns, such as
				<span class="font-mono">articles.csv</span>. Rows land for review without a fetch.
			</p>
			<input
				id="csv"
				type="file"
				name="file"
				accept=".csv,text/csv"
				required
				class="text-muted file:border-line file:bg-surface-2 file:text-fg text-sm file:mr-3 file:rounded-lg file:border file:px-3 file:py-1.5"
			/>
			<button class="btn w-fit" disabled={busy !== null}>
				{busy === 'csv' ? 'Importing…' : 'Import CSV'}
			</button>
		</form>
	</div>

	{#if form?.message}
		<p class="mt-4 text-sm" role="status">{form.message}</p>
	{/if}

	<nav class="border-line mt-8 flex gap-1 overflow-x-auto border-b" aria-label="Harvest status">
		{#each TABS as t (t.status)}
			<a
				href="{resolve('/harvest')}?{query(t.status)}"
				data-sveltekit-noscroll
				aria-current={data.status === t.status ? 'page' : undefined}
				class="-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm {data.status ===
				t.status
					? 'border-accent text-fg font-semibold'
					: 'text-muted hover:text-fg border-transparent'}"
			>
				{t.label}
				<span class="text-muted font-mono text-xs">{data.count[t.status]}</span>
			</a>
		{/each}
	</nav>

	<form
		method="POST"
		action="?/fetch"
		bind:this={fetchForm}
		use:enhance={trackFetch}
		class="mt-4 flex flex-wrap items-center gap-3"
		class:hidden={data.count.queued === 0 && !fetching}
	>
		<button class="btn" disabled={fetching}>
			{fetching ? `Fetching… ${data.count.queued} left` : `Fetch ${data.count.queued} queued`}
		</button>
		{#if fetching}
			<button type="button" class="btn btn-ghost" onclick={() => (stop = true)} disabled={stop}>
				{stop ? 'Stopping…' : 'Stop'}
			</button>
		{/if}
		<span class="text-muted text-xs">One request a second per site, robots.txt respected.</span>
	</form>

	{#if data.items.length}
		<form method="POST" class="mt-4" use:enhance={track('bulk')}>
			{#if data.status !== 'accepted' && data.status !== 'queued'}
				<div
					class="panel z-10 flex flex-wrap items-end gap-3 p-3 sm:sticky sm:top-16"
					aria-label="Selected links"
				>
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={allSelected}
							onchange={(e) => (selected = e.currentTarget.checked ? [...allIds] : [])}
							aria-label="Select all on this page"
						/>
						<span class="text-muted font-mono text-xs">{selected.length} selected</span>
					</label>
					{#if data.status === 'ready' || data.status === 'duplicate'}
						<label class="text-muted flex flex-col gap-1 text-xs">
							Deck
							<select name="deck" class="input py-1.5 text-sm sm:w-56">
								{#each data.decks as d (d)}<option value={d}>{d}</option>{/each}
								{#if !data.decks.length}<option value="">No decks yet</option>{/if}
							</select>
						</label>
						<label class="text-muted flex flex-col gap-1 text-xs">
							or a new deck
							<input name="newDeck" class="input py-1.5 text-sm sm:w-44" placeholder="Reading" />
						</label>
						<label class="text-muted flex flex-col gap-1 text-xs">
							Tags
							<input name="tags" class="input py-1.5 text-sm sm:w-40" placeholder="web infosec" />
						</label>
						<button class="btn btn-primary" formaction="?/accept" disabled={busy !== null}>
							Add to deck
						</button>
					{/if}
					{#if data.status === 'failed' || data.status === 'discarded'}
						<button class="btn" formaction="?/retry" disabled={busy !== null}>Retry</button>
					{/if}
					{#if data.status !== 'discarded'}
						<button class="btn btn-ghost" formaction="?/discard" disabled={busy !== null}>
							Discard
						</button>
					{/if}
				</div>
			{/if}

			<ul class="mt-3 space-y-2">
				{#each data.items as item (item.id)}
					{@const p = item.proposal}
					<li class="panel flex gap-3 p-4">
						{#if data.status !== 'accepted' && data.status !== 'queued'}
							<input
								type="checkbox"
								name="id"
								value={item.id}
								bind:group={selected}
								class="mt-1 shrink-0"
								aria-label="Select {p?.title ?? item.url}"
							/>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="text-muted flex flex-wrap items-center gap-2 text-xs">
								<span class="font-mono">{item.domain}</span>
								{#if item.tier}
									<span class="chip py-0 text-[11px] {TIER_CHIP[item.tier] ?? ''}">{item.tier}</span
									>
								{/if}
								{#if p?.publishedAt}<span>{p.publishedAt.slice(0, 10)}</span>{/if}
							</div>
							<a
								href={p?.finalUrl ?? item.url}
								target="_blank"
								rel="noopener noreferrer"
								class="mt-1 block font-semibold break-words hover:underline"
								>{p?.title ?? item.url}</a
							>
							{#if p?.description ?? p?.excerpt}
								<p class="text-muted mt-1 line-clamp-2 text-sm">{p?.description ?? p?.excerpt}</p>
							{/if}
							{#if item.failReason}
								<p class="text-again mt-1 text-sm">{item.failReason}</p>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</form>

		{#if data.pages > 1}
			<nav class="mt-4 flex items-center justify-between" aria-label="Harvest pages">
				{#if data.page > 1}
					<a
						class="btn px-3 py-1.5"
						href="{resolve('/harvest')}?{query(data.status, data.page - 1)}">← Prev</a
					>
				{:else}
					<span></span>
				{/if}
				<span class="text-muted font-mono text-xs">Page {data.page} of {data.pages}</span>
				{#if data.page < data.pages}
					<a
						class="btn px-3 py-1.5"
						href="{resolve('/harvest')}?{query(data.status, data.page + 1)}">Next →</a
					>
				{:else}
					<span></span>
				{/if}
			</nav>
		{/if}
	{:else}
		<p class="panel text-muted mt-4 p-10 text-center text-sm">
			{data.status === 'ready' ? 'Nothing to review. Paste some links above.' : 'Nothing here.'}
		</p>
	{/if}
</main>
