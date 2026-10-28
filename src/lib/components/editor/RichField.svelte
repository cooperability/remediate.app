<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { sanitizeCardHtml } from '$lib/cards/sanitize';

	let {
		id,
		label,
		name,
		value = $bindable(''),
		invalid = false,
		describedby
	}: {
		id: string;
		label: string;
		name: string;
		value?: string;
		invalid?: boolean;
		describedby?: string;
	} = $props();

	let el = $state<HTMLDivElement>();
	let source = $state(false);

	// Typing writes innerHTML into value, so they only differ when value was set
	// from outside (a revert, the source view): then the DOM follows.
	$effect(() => {
		// Svelte renders nothing inside the field, so the DOM here is ours to set.
		// eslint-disable-next-line svelte/no-dom-manipulating
		if (el && !source && el.innerHTML !== value) el.innerHTML = value;
	});

	onMount(() => {
		// Tags, not inline styles: the sanitizer drops style attributes, and with them the formatting.
		document.execCommand('styleWithCSS', false, 'false');
	});

	function sync() {
		if (el) value = el.innerHTML;
	}

	async function toggleSource() {
		if (source) value = sanitizeCardHtml(value);
		source = !source;
		// The view that had focus is gone. The one that replaced it takes it, so the format bar follows.
		await tick();
		document.getElementById(id)?.focus();
	}

	// Pasted HTML goes through the same sanitizer as a save, so the field never
	// holds markup the card cannot.
	function onpaste(e: ClipboardEvent) {
		const html = e.clipboardData?.getData('text/html');
		const text = e.clipboardData?.getData('text/plain') ?? '';
		e.preventDefault();
		if (html) document.execCommand('insertHTML', false, sanitizeCardHtml(html));
		else document.execCommand('insertText', false, text);
		sync();
	}

	// The formatting shortcuts live on the format bar. This one works in the source view too.
	function onkeydown(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'x') return;
		e.preventDefault();
		toggleSource();
	}
</script>

<div>
	<div class="flex items-center justify-between gap-2">
		<label for={id} class="eyebrow" id="{id}-label">{label}</label>
		<button
			type="button"
			class="btn btn-ghost text-muted min-h-11 px-2 py-1 text-xs lg:min-h-0"
			aria-pressed={source}
			title="HTML source (Ctrl+Shift+X)"
			onclick={toggleSource}
		>
			{source ? 'Rich text' : 'HTML'}
		</button>
	</div>

	{#if !source}
		<div
			bind:this={el}
			{id}
			class="field card-html prose prose-sm dark:prose-invert input mt-2 max-w-none px-3 py-2"
			class:!border-again={invalid}
			contenteditable="true"
			data-rich-field
			role="textbox"
			tabindex="0"
			aria-multiline="true"
			aria-labelledby="{id}-label"
			aria-describedby={describedby}
			aria-invalid={invalid}
			oninput={sync}
			{onpaste}
			{onkeydown}
		></div>
		<input type="hidden" {name} {value} />
	{:else}
		<textarea
			{id}
			{name}
			class="input mt-2 min-h-40 font-mono text-xs"
			spellcheck="false"
			aria-describedby={describedby}
			bind:value
			{onkeydown}></textarea>
	{/if}
</div>

<style>
	.field {
		min-height: 6rem;
		overflow-wrap: anywhere;
		color: var(--fg);
	}
	/* On a phone the field grows and the sheet scrolls, as in Notes: a scroller inside a scroller fights the keyboard. */
	@media (min-width: 64rem) {
		.field {
			max-height: 50vh;
			overflow-y: auto;
		}
	}
	.field:focus {
		outline: none;
	}
	.field :global(img) {
		max-width: 100%;
		height: auto;
	}
	.field :global(code::before),
	.field :global(code::after) {
		content: none;
	}
</style>
