<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { FLAGS, flagOf } from '$lib/cards/edit';
	import { sanitizeCardHtml } from '$lib/cards/sanitize';
	import Flashcard from '$lib/components/study/Flashcard.svelte';
	import type { EditorCard } from '$lib/server/cards/edit';
	import CardInfo from './CardInfo.svelte';
	import FormatBar from './FormatBar.svelte';
	import { STAY } from './forms';
	import RichField from './RichField.svelte';
	import TagInput from './TagInput.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	type Saved = {
		id: string;
		created: boolean;
		front: string;
		back: string;
		deck: string;
		tags: string[];
	};

	let {
		card,
		options,
		initialDeck,
		initialTags,
		closeHref,
		returnTo,
		dirty = $bindable(false),
		onsaved,
		ondeleted,
		onnotice
	}: {
		card: EditorCard | null;
		options: { decks: string[]; tags: string[] };
		initialDeck: string;
		initialTags: string[];
		closeHref: string;
		returnTo: string | null;
		dirty?: boolean;
		onsaved: (s: Saved) => void;
		ondeleted: (d: { trashId: string; count: number }) => void;
		onnotice: (message: string) => void;
	} = $props();

	// The page keys this component by card, so these start from the card each time.
	// svelte-ignore state_referenced_locally
	const start = {
		front: card?.front ?? '',
		back: card?.back ?? '',
		deck: card?.deck ?? initialDeck,
		tags: card?.tags ?? initialTags
	};
	let base = $state(start);
	let front = $state(start.front);
	let back = $state(start.back);
	let deck = $state(start.deck);
	let tags = $state([...start.tags]);
	let tab = $state<'edit' | 'preview' | 'info'>('edit');
	let previewBack = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let duplicates = $state<{ id: string; deck: string }[]>([]);
	let root = $state<HTMLDivElement>();
	let form = $state<HTMLFormElement>();
	let suspendForm = $state<HTMLFormElement>();
	let deleteForm = $state<HTMLFormElement>();
	// The rich field the format bar acts on. Focus on the bar itself keeps it.
	let field = $state<HTMLElement | null>(null);

	function onfocusin(e: FocusEvent) {
		const t = e.target as Element;
		if (!t.closest('[data-format-bar]')) field = t.closest<HTMLElement>('[data-rich-field]');
	}

	function onfocusout(e: FocusEvent) {
		const to = e.relatedTarget;
		if (!(to instanceof Node) || !root?.contains(to)) field = null;
	}

	$effect(() => {
		dirty =
			front !== base.front ||
			back !== base.back ||
			deck !== base.deck ||
			tags.join('\u0000') !== base.tags.join('\u0000');
	});

	const newDeck = $derived(deck.trim() !== '' && !options.decks.includes(deck.trim()));
	const flag = $derived(flagOf(card?.flag ?? 0));

	// Anki marks a duplicate front while it is typed. Debounced, and only the latest answer counts.
	let asked = 0;
	$effect(() => {
		const text = front;
		const exclude = card?.id ?? null;
		const ask = ++asked;
		const t = setTimeout(async () => {
			try {
				const res = await fetch('/api/cards/duplicates', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ front: text, exclude })
				});
				if (res.ok && ask === asked) duplicates = await res.json();
			} catch {
				// Advisory only: a failed check must not block typing or saving.
			}
		}, 400);
		return () => clearTimeout(t);
	});

	function revert() {
		front = base.front;
		back = base.back;
		deck = base.deck;
		tags = [...base.tags];
		error = null;
	}

	const inField = (t: EventTarget | null) =>
		t instanceof Element && Boolean(t.closest('input, textarea, select, [contenteditable="true"]'));
	// A checkbox or a select takes no text, so Escape from one still closes the card.
	const typing = (t: EventTarget | null) =>
		inField(t) && !(t as Element).closest('input[type="checkbox"], select');

	function onkeydown(e: KeyboardEvent) {
		// Typing in another field on the page (search, the bulk bar) keeps its keys:
		// Escape there must not close this card, nor Ctrl+Enter save it.
		if (typing(e.target) && !root?.contains(e.target as Node)) return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key === 'Enter') {
			e.preventDefault();
			form?.requestSubmit();
		} else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
			e.preventDefault();
			tab = tab === 'preview' ? 'edit' : 'preview';
		} else if (mod && !e.shiftKey && e.key.toLowerCase() === 'j' && suspendForm) {
			e.preventDefault();
			suspendForm.requestSubmit();
		} else if (mod && e.key === 'Delete' && deleteForm && !inField(e.target)) {
			// In a field Ctrl+Delete deletes the next word. It must not take the card with it.
			e.preventDefault();
			deleteForm.requestSubmit();
		} else if (e.key === 'Escape' && !e.defaultPrevented) {
			// The page asks first when there are unsaved changes (beforeNavigate).
			goto(closeHref, { reset: false });
		}
	}

	// The small forms beside the main one: report, then refresh the page's data.
	const quiet =
		(done?: () => void): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			if (result.type === 'failure') error = String(result.data?.message ?? 'Could not save.');
			else if (result.type === 'success') {
				done?.();
				await update(STAY);
			} else await update(STAY);
		};

	// A delete closes the editor, so the page navigates instead of reloading this card.
	const removing: SubmitFunction =
		() =>
		async ({ result, update }) => {
			if (result.type === 'failure') error = String(result.data?.message ?? 'Could not delete.');
			else if (result.type === 'success')
				ondeleted(result.data as { trashId: string; count: number });
			else await update(STAY);
		};
</script>

<svelte:window {onkeydown} />

<div bind:this={root} class="flex min-h-full flex-col" {onfocusin} {onfocusout}>
	<header class="border-line flex items-center gap-2 border-b px-4 py-3">
		<a
			href={closeHref}
			class="btn btn-ghost text-muted -ml-2 min-h-11 px-2 lg:min-h-0"
			data-sveltekit-noscroll
			aria-label="Close editor"
			title="Close (Esc)"><ArrowLeft class="size-4" /><span class="lg:hidden">Cards</span></a
		>
		<h2 class="min-w-0 flex-1 truncate font-semibold">
			{card ? 'Edit card' : 'New card'}
			{#if card?.suspended}<span class="chip border-hard/40 text-hard ml-1">suspended</span>{/if}
		</h2>
		{#if card}
			<details class="relative">
				<summary
					class="btn btn-ghost min-h-11 list-none px-2 lg:min-h-0 [&::-webkit-details-marker]:hidden"
					title="Flag"
					aria-label="Flag: {flag?.label ?? 'none'}"
				>
					<span class="size-3 rounded-full {flag ? flag.cls : 'border-line border'}"></span>
					<span class="sr-only lg:not-sr-only lg:text-xs">{flag?.label ?? 'Flag'}</span>
				</summary>
				<form
					method="POST"
					action="?/bulk"
					class="panel absolute right-0 z-10 mt-1 grid w-44 gap-0.5 p-1 shadow-lg"
					use:enhance={quiet()}
				>
					<input type="hidden" name="op" value="flag" />
					<input type="hidden" name="id" value={card.id} />
					{#each [{ value: 0, label: 'No flag', cls: 'border-line border' }, ...FLAGS] as f (f.value)}
						<button
							name="flag"
							value={f.value}
							class="hover:bg-surface-2 flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm lg:min-h-8"
							aria-pressed={card.flag === f.value}
						>
							<span class="size-3 rounded-full {f.cls}"></span>{f.label}
						</button>
					{/each}
				</form>
			</details>
			<form bind:this={suspendForm} method="POST" action="?/bulk" use:enhance={quiet()}>
				<input type="hidden" name="op" value={card.suspended ? 'unsuspend' : 'suspend'} />
				<input type="hidden" name="id" value={card.id} />
				<button class="btn btn-ghost min-h-11 px-2 text-xs lg:min-h-0" title="Suspend (Ctrl+J)">
					{card.suspended ? 'Unsuspend' : 'Suspend'}
				</button>
			</form>
			<form bind:this={deleteForm} method="POST" action="?/delete" use:enhance={removing}>
				<input type="hidden" name="id" value={card.id} />
				<button
					class="btn btn-ghost text-again min-h-11 px-2 text-xs lg:min-h-0"
					title="Delete (Ctrl+Delete)">Delete</button
				>
			</form>
		{/if}
	</header>

	<div class="border-line flex gap-1 border-b px-4" role="tablist" aria-label="Editor views">
		{#each [['edit', 'Edit'], ['preview', 'Preview'], ...(card ? [['info', 'Info']] : [])] as [key, label] (key)}
			<button
				type="button"
				role="tab"
				class="text-muted aria-selected:border-accent aria-selected:text-fg -mb-px min-h-11 border-b-2 border-transparent px-3 text-sm"
				aria-selected={tab === key}
				onclick={() => (tab = key as typeof tab)}
				>{label}{#if key === 'preview'}<span class="kbd ml-2 hidden lg:inline-flex">Ctrl ⇧ P</span
					>{/if}</button
			>
		{/each}
	</div>

	<form
		bind:this={form}
		method="POST"
		action="?/save"
		class="flex flex-1 flex-col"
		hidden={tab === 'info'}
		use:enhance={({ cancel }) => {
			// requestSubmit (Ctrl+Enter) ignores the disabled Save button, so a second press lands here.
			if (saving) return cancel();
			saving = true;
			error = null;
			return async ({ result, update }) => {
				saving = false;
				if (result.type === 'failure') {
					error = String(result.data?.message ?? 'Could not save.');
				} else if (result.type === 'success' && result.data) {
					const s = result.data as Saved;
					// What the server stored is the new baseline, sanitizer changes included.
					base = s.created ? { ...base, front: '', back: '', deck: s.deck, tags: s.tags } : s;
					front = base.front;
					back = base.back;
					deck = s.deck;
					tags = [...s.tags];
					onsaved(s);
				} else await update(STAY);
			};
		}}
	>
		{#if card}<input type="hidden" name="id" value={card.id} />{/if}

		<div class="flex-1 space-y-5 px-4 py-4" hidden={tab !== 'edit'}>
			<div>
				<label for="edit-deck" class="eyebrow">Deck</label>
				<input
					id="edit-deck"
					name="deck"
					class="input mt-1 min-h-11 text-sm"
					list="edit-deck-list"
					autocomplete="off"
					required
					maxlength="200"
					bind:value={deck}
				/>
				<datalist id="edit-deck-list">
					{#each options.decks as d (d)}<option value={d}></option>{/each}
				</datalist>
				{#if newDeck}<p class="text-muted mt-1 text-xs">New deck: saving creates it.</p>{/if}
			</div>

			<RichField
				id="edit-front"
				name="front"
				label="Front"
				bind:value={front}
				invalid={duplicates.length > 0}
				describedby={duplicates.length ? 'edit-dupes' : undefined}
			/>
			{#if duplicates.length}
				<p id="edit-dupes" class="text-hard -mt-3 text-xs" role="status">
					Same front as
					{#each duplicates as d, i (d.id)}{i ? ', ' : ''}<a
							class="underline"
							href="{resolve('/cards/browse')}?card={d.id}"
							data-sveltekit-noscroll>a card in {d.deck}</a
						>{/each}.
				</p>
			{/if}

			<RichField id="edit-back" name="back" label="Back" bind:value={back} />

			<div>
				<label for="edit-tags" class="eyebrow">Tags</label>
				<div class="mt-1"><TagInput id="edit-tags" bind:tags suggestions={options.tags} /></div>
			</div>
		</div>

		{#if tab === 'preview'}
			<div class="flex-1 px-4 py-4">
				<p class="text-muted mb-3 text-xs">
					As Study shows it. Tap the card or use the buttons to turn it.
				</p>
				<div class="mb-3 flex gap-2">
					<button
						type="button"
						class="btn min-h-11 px-3 lg:min-h-0"
						aria-pressed={!previewBack}
						onclick={() => (previewBack = false)}>Front</button
					>
					<button
						type="button"
						class="btn min-h-11 px-3 lg:min-h-0"
						aria-pressed={previewBack}
						onclick={() => (previewBack = true)}>Back</button
					>
				</div>
				<button
					type="button"
					class="block w-full text-left"
					aria-label="Turn the preview card"
					onclick={() => (previewBack = !previewBack)}
				>
					<Flashcard
						card={{ front: sanitizeCardHtml(front), back: sanitizeCardHtml(back), tags }}
						flipped={previewBack}
					/>
				</button>
			</div>
		{/if}

		<div
			class="border-line bg-bg/90 lg:bg-surface/90 pb-safe sticky bottom-0 mt-auto flex flex-wrap items-center gap-2 border-t px-4 pt-3 backdrop-blur"
		>
			{#if tab === 'edit'}<FormatBar {field} />{/if}
			{#if error}<p class="text-again w-full text-sm" role="alert">{error}</p>{/if}
			<button class="btn btn-primary min-h-11 px-5" disabled={saving}>
				{saving ? 'Saving…' : card ? 'Save' : 'Add card'}
				<span class="kbd hidden border-transparent bg-black/10 text-current lg:inline-flex"
					>Ctrl ↵</span
				>
			</button>
			{#if dirty}
				<button type="button" class="btn btn-ghost min-h-11" onclick={revert}>Revert</button>
				<span class="text-muted text-xs">Unsaved changes</span>
			{:else if returnTo}
				<a href={returnTo} class="btn btn-ghost min-h-11">Back</a>
			{/if}
		</div>
	</form>

	<!-- Outside the save form: a form cannot hold another. -->
	{#if tab === 'info' && card}
		<CardInfo
			{card}
			{error}
			forget={quiet(() => onnotice('Schedule reset. The card is new again.'))}
		/>
	{/if}
</div>
