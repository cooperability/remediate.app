<script lang="ts">
	import { normalizeTags } from '$lib/cards/edit';

	let {
		id,
		tags = $bindable([]),
		suggestions,
		name = 'tag'
	}: { id: string; tags?: string[]; suggestions: string[]; name?: string } = $props();

	let draft = $state('');
	let focused = $state(false);
	let dismissed = $state(false);
	let pick = $state(-1);
	let input = $state<HTMLInputElement>();

	// Anki's completer, from the user's own tags: a tag that starts with what is
	// typed first, then one with a `::` part that does, then any that contain it.
	// Tags already on the card drop out.
	const matches = $derived.by(() => {
		const q = draft.trim().toLowerCase();
		if (!q) return [];
		const have = new Set(tags.map((t) => t.toLowerCase()));
		const rank = (s: string) => {
			const l = s.toLowerCase();
			return l.startsWith(q)
				? 0
				: l.split('::').some((p) => p.startsWith(q))
					? 1
					: l.includes(q)
						? 2
						: 3;
		};
		return suggestions
			.filter((s) => !have.has(s.toLowerCase()))
			.map((s) => [rank(s), s] as const)
			.filter(([r]) => r < 3)
			.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
			.slice(0, 8)
			.map(([, s]) => s);
	});
	const open = $derived(focused && !dismissed && matches.length > 0);

	// A tag typed in another case is the one the user already has, as in Anki.
	const known = $derived(new Map(suggestions.map((s) => [s.toLowerCase(), s])));

	function commit(text = draft) {
		const typed = text.split(/\s+/).map((t) => known.get(t.toLowerCase()) ?? t);
		if (text.trim()) tags = normalizeTags([...tags, ...typed]);
		draft = '';
		pick = -1;
	}

	// Tapping a chip takes it back into the box for editing.
	function edit(tag: string) {
		commit();
		tags = tags.filter((t) => t !== tag);
		draft = tag;
		input?.focus();
	}

	// Space and Enter commit, as in Anki's tag editor, and take the highlighted
	// suggestion when there is one. Tab moves on, and blur commits. Backspace in
	// an empty box takes the last chip back for editing.
	function onkeydown(e: KeyboardEvent) {
		if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
			e.preventDefault();
			const n = matches.length;
			pick = e.key === 'ArrowDown' ? (pick + 1) % n : pick <= 0 ? n - 1 : pick - 1;
		} else if (['Enter', ' ', 'Tab'].includes(e.key) && open && pick >= 0) {
			e.preventDefault();
			commit(matches[pick]);
		} else if (e.key === 'Enter' || e.key === ' ') {
			if (!draft.trim()) return;
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape' && open) {
			// Closes the list, not the card.
			e.preventDefault();
			dismissed = true;
		} else if (e.key === 'Backspace' && !draft && tags.length) {
			e.preventDefault();
			draft = tags.at(-1)!;
			tags = tags.slice(0, -1);
		}
	}

	// Phone keyboards send no key for space, and a paste can bring several tags.
	function oninput() {
		dismissed = false;
		pick = -1;
		if (/\s/.test(draft)) commit();
	}
</script>

<div class="relative">
	<div
		class="input flex min-h-11 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:border-[var(--accent)]"
	>
		{#each tags as tag (tag)}
			<span class="chip text-fg gap-0 py-0 pr-0.5 pl-0">
				<button
					type="button"
					class="min-h-7 rounded-full pl-2.5 lg:min-h-5"
					aria-label="Edit tag {tag}"
					onclick={() => edit(tag)}>{tag}</button
				>
				<button
					type="button"
					class="hover:text-again inline-flex size-7 items-center justify-center rounded-full lg:size-5"
					aria-label="Remove tag {tag}"
					onclick={() => (tags = tags.filter((t) => t !== tag))}>×</button
				>
				<input type="hidden" {name} value={tag} />
			</span>
		{/each}
		<input
			bind:this={input}
			{id}
			class="min-w-24 flex-1 border-0 bg-transparent p-1 text-sm focus:ring-0"
			role="combobox"
			aria-expanded={open}
			aria-controls="{id}-list"
			aria-autocomplete="list"
			aria-activedescendant={open && pick >= 0 ? `${id}-opt-${pick}` : undefined}
			placeholder={tags.length ? '' : 'Add tags, space to separate'}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			enterkeyhint="done"
			bind:value={draft}
			{onkeydown}
			{oninput}
			onfocus={() => (focused = true)}
			onblur={() => {
				focused = false;
				commit();
			}}
		/>
	</div>
	<!-- In the flow on a phone, so the keyboard or the sticky footer never covers it. -->
	<ul
		id="{id}-list"
		role="listbox"
		aria-label="Tag suggestions"
		class="panel z-20 mt-1 max-h-60 overflow-y-auto p-1 shadow-lg lg:absolute lg:inset-x-0 lg:top-full"
		hidden={!open}
	>
		{#each open ? matches : [] as s, i (s)}
			<!-- The box keeps focus and handles the keys, as a combobox does. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				id="{id}-opt-{i}"
				role="option"
				aria-selected={i === pick}
				class="hover:bg-surface-2 aria-selected:bg-accent-soft flex min-h-11 cursor-pointer items-center rounded-lg px-2 text-sm lg:min-h-8"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => commit(s)}
			>
				{s}
			</li>
		{/each}
	</ul>
</div>
