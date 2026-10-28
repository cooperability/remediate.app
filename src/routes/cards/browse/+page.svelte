<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { beforeNavigate, goto, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { FLAGS, flagOf } from '$lib/cards/edit';
	import BulkBar from '$lib/components/editor/BulkBar.svelte';
	import CardEditor from '$lib/components/editor/CardEditor.svelte';
	import Toast, { type Toast as ToastData } from '$lib/components/editor/Toast.svelte';
	import StudyLink from '$lib/components/deck/StudyLink.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Play from '@lucide/svelte/icons/play';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';

	let { data } = $props();

	const p = $derived(data.browse.params);
	const cards = $derived(data.browse.cards);
	const editing = $derived(Boolean(data.card || data.creating));
	const sheet = $derived(editing || data.missing);

	/** This page's URL with some params changed; null removes one. */
	function href(changes: Record<string, string | null>) {
		const sp = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) sp.delete(k);
			else sp.set(k, v);
		}
		const qs = sp.toString();
		return `${resolve('/cards/browse')}${qs ? `?${qs}` : ''}`;
	}
	const cardHref = (id: string) => href({ card: id, new: null });
	const newHref = $derived(href({ card: null, new: '1' }));
	const closeHref = $derived(data.returnTo ?? href({ card: null, new: null }));

	const STATE_CHIP = {
		new: '',
		learning: 'border-hard/40 text-hard',
		review: 'border-good/40 text-good',
		relearning: 'border-again/40 text-again'
	} as const;
	const STATES = ['new', 'learning', 'review', 'relearning', 'suspended'];
	const SORTS = [
		['due', 'Due soonest'],
		['stability', 'Weakest first'],
		['lapses', 'Most lapses'],
		['recent', 'Recently reviewed'],
		['created', 'Newest added'],
		['edited', 'Recently edited']
	];
	const filters = $derived([
		{
			id: 'deck',
			label: 'Deck',
			value: data.deck ?? '',
			all: 'All decks',
			items: data.options.decks.map((d) => [d, d])
		},
		{
			id: 'tag',
			label: 'Tag',
			value: p.tag ?? '',
			all: 'All tags',
			items: data.browse.tags.map((t) => [t, t])
		},
		{
			id: 'state',
			label: 'State',
			value: p.state ?? '',
			all: 'Any state',
			items: STATES.map((s) => [s, s])
		},
		{
			id: 'flag',
			label: 'Flag',
			value: p.flag === null ? '' : String(p.flag),
			all: 'Any flag',
			items: [['0', 'No flag'], ...FLAGS.map((f) => [String(f.value), f.label])]
		},
		{ id: 'sort', label: 'Sort', value: p.sort as string, all: null, items: SORTS }
	]);

	// Bulk selection is per page: what you can see is what you act on.
	let selected = $state<string[]>([]);
	$effect(() => {
		const visible = new Set(cards.map((c) => c.id));
		const kept = selected.filter((id) => visible.has(id));
		if (kept.length !== selected.length) selected = kept;
	});
	const allChecked = $derived(cards.length > 0 && selected.length === cards.length);

	let dirty = $state(false);
	beforeNavigate((nav) => {
		if (!dirty) return;
		// Closing or reloading the tab: the browser asks, in its own words.
		if (nav.willUnload) return nav.cancel();
		if (!confirm('Discard unsaved changes to this card?')) nav.cancel();
		else dirty = false;
	});

	let toast = $state<ToastData | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function notify(t: ToastData) {
		toast = t;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), t.trashId ? 12_000 : 5_000);
	}

	function onsaved(s: { id: string; created: boolean; deck: string }) {
		dirty = false;
		if (data.returnTo) return goto(data.returnTo);
		if (s.created)
			notify({
				message: `Added to ${s.deck}.`,
				link: { href: cardHref(s.id), label: 'Open' }
			});
		else notify({ message: 'Saved.' });
		refreshAll();
	}

	// The list, not returnTo: Undo lives in this page's toast.
	function ondeleted(d: { trashId: string; count: number }, closes: boolean) {
		dirty = false;
		notify({ message: `Deleted ${d.count} card${d.count === 1 ? '' : 's'}.`, trashId: d.trashId });
		if (closes) goto(href({ card: null, new: null }), { reset: false });
		else refreshAll();
	}

	let search = $state<HTMLInputElement>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	function submitSoon(form: HTMLFormElement | null, delay = 0) {
		clearTimeout(timer);
		timer = setTimeout(() => form?.requestSubmit(), delay);
	}

	// Browser shortcuts, Anki's where a browser lets a page have them. Never while typing.
	function onkeydown(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		const t = e.target instanceof Element ? e.target : null;
		if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
		if (e.key === '/') {
			e.preventDefault();
			search?.focus();
		} else if (e.key === 'n' || e.key === 'N') {
			e.preventDefault();
			goto(newHref, { reset: false });
		} else if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key) && cards.length) {
			// Arrows belong to the page's scroll unless the list has focus.
			if (e.key.startsWith('Arrow') && !t?.closest('[data-card-list]')) return;
			e.preventDefault();
			const at = cards.findIndex((c) => c.id === data.card?.id);
			const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1;
			const next = cards[Math.min(cards.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
			goto(cardHref(next.id), { reset: false, replace: true });
			document.querySelector(`[data-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
		}
	}

	// iOS draws the keyboard over a fixed sheet. Pin the sheet to the visual
	// viewport so its Save bar sits above the keyboard, not behind it.
	let vv = $state<{ h: number; top: number } | null>(null);
	onMount(() => {
		const v = window.visualViewport;
		if (!v) return;
		const fit = () => (vv = { h: v.height, top: v.offsetTop });
		fit();
		v.addEventListener('resize', fit);
		v.addEventListener('scroll', fit);
		return () => {
			v.removeEventListener('resize', fit);
			v.removeEventListener('scroll', fit);
		};
	});
	$effect(() => {
		document.documentElement.classList.toggle('sheet-open', sheet);
		return () => document.documentElement.classList.remove('sheet-open');
	});

	const first = $derived((p.page - 1) * data.browse.pageSize + 1);
	const last = $derived(first + cards.length - 1);
	const filtered = $derived(Boolean(p.q || p.tag || p.state || p.flag !== null));
	// Phones fold the five selects behind one button; the badge says how many are set.
	// The fold is CSS from the first paint, so the list does not jump at hydration.
	// Without JS the button cannot open them, so the selects stay visible. Hidden is the
	// default and noscript the exception: a browser without the scripting feature folds.
	let filtersOpen = $state(false);
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	const narrowing = $derived(
		[data.deck, p.tag, p.state, p.flag].filter((v) => v != null && v !== '').length
	);
	const pageHref = (n: number) => href({ page: n > 1 ? String(n) : null });
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>{data.deck ?? 'All cards'} · Browse · Remediate</title>
</svelte:head>

<main
	class="mx-auto max-w-7xl px-4 py-6 sm:py-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start lg:gap-6"
>
	<section class="min-w-0" aria-labelledby="browse-title">
		<a
			href={data.returnTo ??
				(data.deck
					? `${resolve('/cards/deck')}?deck=${encodeURIComponent(data.deck)}`
					: resolve('/cards'))}
			class="text-muted hover:text-fg -ml-1 inline-flex min-h-11 items-center gap-1.5 text-sm lg:min-h-0"
			><ArrowLeft class="size-4" /> {data.returnTo ? 'Back' : data.deck ? 'Deck' : 'Decks'}</a
		>
		<header class="mt-2 flex flex-wrap items-end justify-between gap-3">
			<div class="min-w-0">
				<p class="eyebrow">Browse</p>
				<h1 id="browse-title" class="mt-1 text-2xl font-bold tracking-tight break-words">
					{data.deck ?? 'All cards'}
				</h1>
			</div>
			<div class="flex gap-2">
				{#if data.deck}
					<StudyLink deck={data.deck} class="btn min-h-11">
						<Play class="size-4 fill-current" /> Study
					</StudyLink>
				{/if}
				<a href={newHref} class="btn btn-primary min-h-11" data-sveltekit-noscroll>
					<Plus class="size-4" /> New card
					<span class="kbd hidden border-transparent bg-black/10 text-current lg:inline-flex"
						>N</span
					>
				</a>
			</div>
		</header>

		<div class="panel mt-4 overflow-hidden">
			<form
				method="GET"
				action={resolve('/cards/browse')}
				data-sveltekit-keepfocus
				data-sveltekit-noscroll
				class="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3"
			>
				{#if data.card}<input type="hidden" name="card" value={data.card.id} />{/if}
				{#if data.returnTo}<input type="hidden" name="return" value={data.returnTo} />{/if}
				<label class="sr-only" for="browse-q">Search cards</label>
				<div class="relative col-span-2 flex gap-2 sm:col-span-3">
					<Search
						class="text-muted pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
					/>
					<input
						bind:this={search}
						id="browse-q"
						class="input min-h-11 flex-1 pr-10 pl-10 text-sm"
						type="search"
						name="q"
						value={p.q}
						placeholder="Search front and back"
						maxlength="200"
						oninput={(e) => submitSoon(e.currentTarget.form, 350)}
					/>
					<span
						class="kbd pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 lg:inline-flex"
						>/</span
					>
					<button
						type="button"
						class="btn relative size-11 shrink-0 p-0 sm:hidden noscript:hidden"
						disabled={!hydrated}
						aria-expanded={filtersOpen}
						aria-controls="browse-filters"
						aria-label="Filters{narrowing ? `, ${narrowing} set` : ''}"
						onclick={() => (filtersOpen = !filtersOpen)}
					>
						<SlidersHorizontal class="size-4" />
						{#if narrowing}
							<span
								class="bg-accent text-accent-fg absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full font-mono text-[10px] font-semibold"
								aria-hidden="true">{narrowing}</span
							>
						{/if}
					</button>
				</div>
				<div id="browse-filters" class="contents">
					{#each filters as f (f.id)}
						<label class="sr-only" for="browse-{f.id}">{f.label}</label>
						<select
							id="browse-{f.id}"
							name={f.id}
							class="input min-h-11 min-w-0 text-sm {f.id === 'deck'
								? 'col-span-2 sm:col-span-1'
								: ''} {filtersOpen ? '' : 'max-sm:hidden noscript:max-sm:block'}"
							onchange={(e) => submitSoon(e.currentTarget.form)}
						>
							{#if f.all !== null}<option value="" selected={!f.value}>{f.all}</option>{/if}
							{#each f.items as [value, label] (value)}
								<option {value} selected={f.value === value}>{label}</option>
							{/each}
						</select>
					{/each}
				</div>
				<noscript><button class="btn">Apply</button></noscript>
			</form>

			<div class="border-line flex items-center justify-between gap-3 border-t px-4 py-2">
				<label class="text-muted flex min-h-11 items-center gap-2 text-xs lg:min-h-0">
					<input
						type="checkbox"
						class="size-5 lg:size-4"
						checked={allChecked}
						indeterminate={selected.length > 0 && !allChecked}
						disabled={!cards.length}
						onchange={(e) => (selected = e.currentTarget.checked ? cards.map((c) => c.id) : [])}
					/>
					Select page
				</label>
				<span class="text-muted font-mono text-xs">
					{data.browse.total
						? `${first}–${last} of ${data.browse.total}`
						: filtered
							? 'No matches'
							: 'No cards'}
				</span>
			</div>

			{#if selected.length}
				<BulkBar
					ids={selected}
					options={data.options}
					onclear={() => (selected = [])}
					onnotice={(message) => notify({ message })}
					ondeleted={(d) => ondeleted(d, Boolean(data.card && selected.includes(data.card.id)))}
				/>
			{/if}

			{#if cards.length}
				<ul data-card-list class="border-line border-t">
					{#each cards as c (c.id)}
						{@const flag = flagOf(c.flag)}
						{@const current = data.card?.id === c.id}
						<li
							data-row={c.id}
							class="border-line flex border-b last:border-0"
							class:bg-accent-soft={current}
							class:suspended={c.suspended}
						>
							<label class="flex w-12 shrink-0 cursor-pointer items-start justify-center pt-3.5">
								<span class="sr-only">Select {c.front || 'card'}</span>
								<input
									type="checkbox"
									class="size-5 lg:size-4"
									value={c.id}
									bind:group={selected}
								/>
							</label>
							<a
								href={cardHref(c.id)}
								data-sveltekit-noscroll
								aria-current={current ? 'true' : undefined}
								class="hover:bg-surface-2 grid min-w-0 flex-1 grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 py-3 pr-4"
							>
								<span class="min-w-0 text-sm break-words">
									{#if flag}<span
											class="mr-1.5 inline-block size-2.5 rounded-full align-middle {flag.cls}"
											title="{flag.label} flag"
										></span>{/if}{c.front || '(empty front)'}
								</span>
								<span class="flex flex-col items-end gap-1">
									<span
										class="chip {c.suspended ? 'border-hard/40 text-hard' : STATE_CHIP[c.state]}"
										>{c.suspended ? 'suspended' : c.state}</span
									>
									<span class="font-mono text-[11px] {c.overdue ? 'text-again' : 'text-muted'}"
										>{c.due}</span
									>
								</span>
								{#if !data.deck || c.tags.length}
									<span class="col-span-2 flex flex-wrap gap-1">
										{#if !data.deck}<span class="chip bg-surface py-0 text-[11px]">{c.deck}</span
											>{/if}
										{#each c.tags.slice(0, 6) as tag (tag)}
											<span class="chip py-0 text-[11px]">{tag}</span>
										{/each}
										{#if c.tags.length > 6}<span class="chip py-0 text-[11px]"
												>+{c.tags.length - 6}</span
											>{/if}
									</span>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="border-line text-muted border-t px-5 py-10 text-center text-sm">
					{#if filtered}
						No cards match these filters.
						<a
							class="text-fg underline"
							href={href({ q: null, tag: null, state: null, flag: null, page: null })}
							data-sveltekit-noscroll>Clear filters</a
						>
					{:else}
						No cards here yet. <a class="text-fg underline" href={newHref}>Add one</a>.
					{/if}
				</p>
			{/if}

			{#if data.browse.pages > 1}
				<nav
					class="border-line flex items-center justify-between gap-3 border-t px-4 py-3"
					aria-label="Card pages"
				>
					{#if p.page > 1}
						<a class="btn min-h-11 px-3 py-1.5" href={pageHref(p.page - 1)} data-sveltekit-noscroll
							><ChevronLeft class="size-4" /> Prev</a
						>
					{:else}
						<span class="btn pointer-events-none min-h-11 px-3 py-1.5 opacity-50" aria-hidden="true"
							><ChevronLeft class="size-4" /> Prev</span
						>
					{/if}
					<span class="text-muted font-mono text-xs">Page {p.page} of {data.browse.pages}</span>
					{#if p.page < data.browse.pages}
						<a class="btn min-h-11 px-3 py-1.5" href={pageHref(p.page + 1)} data-sveltekit-noscroll
							>Next <ChevronRight class="size-4" /></a
						>
					{:else}
						<span class="btn pointer-events-none min-h-11 px-3 py-1.5 opacity-50" aria-hidden="true"
							>Next <ChevronRight class="size-4" /></span
						>
					{/if}
				</nav>
			{/if}
		</div>
	</section>

	<!-- Phones: a full-screen sheet over the list. Desktop: a sticky column beside it. -->
	<aside
		aria-label="Card editor"
		class="editor bg-bg lg:border-line lg:bg-surface max-lg:fixed max-lg:inset-x-0 max-lg:z-30 max-lg:overflow-y-auto max-lg:overscroll-contain lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:rounded-2xl lg:border {sheet
			? ''
			: 'max-lg:hidden'}"
		style:--vvh={vv ? `${vv.h}px` : null}
		style:--vvt={vv ? `${vv.top}px` : null}
	>
		{#if editing}
			{#key data.card?.id ?? 'new'}
				<CardEditor
					card={data.card}
					options={data.options}
					initialDeck={data.deck ?? data.options.decks[0] ?? 'Default'}
					initialTags={[]}
					{closeHref}
					returnTo={data.returnTo}
					bind:dirty
					{onsaved}
					ondeleted={(d) => ondeleted(d, true)}
					onnotice={(message) => notify({ message })}
				/>
			{/key}
		{:else if data.missing}
			<div class="p-6 text-center">
				<p class="font-semibold">That card is gone</p>
				<p class="text-muted mt-1 text-sm">It was deleted, or the link is not one of yours.</p>
				<a href={closeHref} class="btn mt-4 min-h-11">Back to the list</a>
			</div>
		{:else}
			<div class="p-8">
				<p class="font-semibold">Pick a card to edit it</p>
				<p class="text-muted mt-1 text-sm">Or add one. The editor opens here.</p>
				<dl class="mt-6 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
					{#each [['N', 'New card'], ['/', 'Search'], ['J K', 'Next, previous card'], ['Ctrl ↵', 'Save'], ['Esc', 'Close the editor'], ['Ctrl ⇧ P', 'Preview'], ['Ctrl ⇧ X', 'HTML source of a field'], ['Tab ⇧ Tab', 'Nest, un-nest a list item'], ['Alt F10', 'Into the formatting bar'], ['Ctrl J', 'Suspend'], ['Ctrl Del', 'Delete']] as [k, v] (k)}
						<dt><span class="kbd">{k}</span></dt>
						<dd class="text-muted">{v}</dd>
					{/each}
				</dl>
			</div>
		{/if}
	</aside>
</main>

{#if toast}
	<Toast {toast} onnotice={(message) => notify({ message })} ondismiss={() => (toast = null)} />
{/if}

<style>
	@media (max-width: 1023.98px) {
		.editor {
			top: var(--vvt, 0px);
			height: var(--vvh, 100dvh);
		}
		:global(html.sheet-open) {
			overflow: hidden;
		}
	}
	.suspended a {
		background-image: repeating-linear-gradient(
			-45deg,
			transparent 0 8px,
			color-mix(in srgb, var(--hard) 7%, transparent) 8px 16px
		);
	}
</style>
