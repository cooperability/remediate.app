<script lang="ts">
	import { flushSync } from 'svelte';
	import { sanitizeCardHtml } from '$lib/cards/sanitize';

	// One bar for every rich field in the editor: it acts on the field that has focus.
	let { field }: { field: HTMLElement | null } = $props();

	type List = 'bullet' | 'dash' | 'number';
	const STATEFUL = ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript'];

	let on = $state<Record<string, boolean>>({});
	let block = $state('');
	let list = $state<List | null>(null);
	let panel = $state<'styles' | 'link' | null>(null);
	let url = $state('');
	let linkInput = $state<HTMLInputElement>();
	// The field's selection while the link box has focus.
	let saved: Range | null = null;

	const escapeHtml = (s: string) =>
		s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

	function range(): Range | null {
		const sel = document.getSelection();
		if (!field || !sel?.rangeCount) return null;
		const r = sel.getRangeAt(0);
		return field.contains(r.commonAncestorContainer) ? r : null;
	}

	/** The nearest element matching `selector` around the caret, inside the field. */
	function around(selector: string): HTMLElement | null {
		const n = range()?.startContainer;
		const hit = (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>(selector);
		return hit && hit !== field && field?.contains(hit) ? hit : null;
	}

	function listKind(): List | null {
		const l = around('ul, ol');
		return !l
			? null
			: l.tagName === 'OL'
				? 'number'
				: l.classList.contains('dashed')
					? 'dash'
					: 'bullet';
	}

	function track() {
		if (!range()) return;
		on = {
			...Object.fromEntries(STATEFUL.map((c) => [c, document.queryCommandState(c)] as const)),
			mark: Boolean(around('mark')),
			code: Boolean(around('code')),
			link: Boolean(around('a'))
		};
		block = document.queryCommandValue('formatBlock').toLowerCase();
		list = listKind();
	}

	$effect(() => {
		if (!field) {
			panel = null;
			return;
		}
		track();
		document.addEventListener('selectionchange', track);
		return () => document.removeEventListener('selectionchange', track);
	});

	// The field's value follows its input event, and direct DOM edits fire none.
	const changed = () => field?.dispatchEvent(new Event('input', { bubbles: true }));

	function run(cmd: string, arg?: string) {
		if (!field?.isConnected) return;
		field.focus();
		document.execCommand(cmd, false, arg);
		changed();
		track();
	}

	function select(node: Node, contents = false) {
		const r = document.createRange();
		if (contents) r.selectNodeContents(node);
		else r.selectNode(node);
		const sel = document.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(r);
	}

	// No execCommand makes these tags, so they go in as HTML, which keeps them on the undo stack.
	function wrap(tag: 'mark' | 'code') {
		const hit = around(tag);
		if (hit) {
			// Unwrapped by hand: Chrome moves a selection around the element to the text
			// inside it, so insertHTML would write the text back into the same element.
			const [first, last] = [hit.firstChild, hit.lastChild];
			hit.replaceWith(...hit.childNodes);
			if (first && last) {
				const r = document.createRange();
				r.setStartBefore(first);
				r.setEndAfter(last);
				const sel = document.getSelection()!;
				sel.removeAllRanges();
				sel.addRange(r);
			}
			changed();
			return track();
		}
		const r = range();
		if (!r || r.collapsed) return;
		const box = document.createElement('div');
		box.append(r.cloneContents());
		const inner = tag === 'code' ? escapeHtml(r.toString()) : sanitizeCardHtml(box.innerHTML);
		run('insertHTML', `<${tag}>${inner}</${tag}>`);
	}

	function toList(kind: List) {
		const now = listKind();
		const cmd = kind === 'number' ? 'insertOrderedList' : 'insertUnorderedList';
		if (now && now !== kind && now !== 'number' && kind !== 'number') {
			// Bullets and dashes are the same list with a different marker.
			around('ul')?.classList.toggle('dashed', kind === 'dash');
			changed();
			return track();
		}
		run(cmd);
		if (kind === 'dash' && now !== 'dash') {
			around('ul')?.classList.add('dashed');
			changed();
			track();
		}
	}

	function indent(out: boolean) {
		if (around('li')) run(out ? 'outdent' : 'indent');
	}

	function style(tag: string) {
		run('formatBlock', `<${tag}>`);
		panel = null;
	}

	// The sanitizer keeps https, http and mailto links only. A bare address gets a scheme.
	const href = $derived.by(() => {
		const u = url.trim();
		if (!u) return null;
		const full = /^[a-z][a-z\d+.-]*:/i.test(u)
			? u
			: /^[^\s/@]+@[^\s/@]+$/.test(u)
				? `mailto:${u}`
				: `https://${u}`;
		return /^(https?:\/\/[^\s/]|mailto:\S)/i.test(full) ? full : null;
	});

	function openLink() {
		const r = range();
		if (!r) return;
		// selectionchange comes late: a key just before this may have left the link.
		track();
		saved = r.cloneRange();
		url = around('a')?.getAttribute('href') ?? '';
		panel = 'link';
		// Synchronously, inside the tap: iOS opens the keyboard only for a focus a gesture made.
		flushSync();
		linkInput?.focus();
		linkInput?.select();
	}

	function closeLink() {
		panel = null;
		field?.focus();
		if (saved) {
			const sel = document.getSelection()!;
			sel.removeAllRanges();
			sel.addRange(saved);
		}
		saved = null;
	}

	function applyLink() {
		const to = href;
		closeLink();
		if (!to) return;
		const a = around('a');
		if (a) select(a, true);
		if (a || !range()?.collapsed) return run('createLink', to);
		run('insertHTML', `<a href="${escapeHtml(to)}">${escapeHtml(to.replace(/^mailto:/i, ''))}</a>`);
	}

	function unlink() {
		closeLink();
		const a = around('a');
		if (!a) return;
		select(a);
		run('unlink');
	}

	// Anki's field shortcuts. Ctrl+B, I and U, and undo and redo, are the browser's own.
	function onkeydown(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		const act =
			e.key === 'Tab' && !mod && around('li')
				? () => indent(e.shiftKey)
				: e.key === 'Escape' && panel
					? () => (panel = null)
					: mod && e.shiftKey && (k === '+' || k === '=')
						? () => run('superscript')
						: mod && !e.shiftKey && k === '='
							? () => run('subscript')
							: mod && !e.shiftKey && k === 'k'
								? openLink
								: null;
		if (!act) return;
		e.preventDefault();
		act();
	}

	$effect(() => {
		const f = field;
		f?.addEventListener('keydown', onkeydown);
		return () => f?.removeEventListener('keydown', onkeydown);
	});

	type Tool = { label: string; title: string; on: () => void; key?: string; cls?: string };
	const TOOLS: (Tool | '|')[] = [
		{ label: '↶', title: 'Undo edit (Ctrl+Z)', on: () => run('undo') },
		{ label: '↷', title: 'Redo edit (Ctrl+Shift+Z)', on: () => run('redo') },
		'|',
		{ label: 'B', title: 'Bold (Ctrl+B)', on: () => run('bold'), key: 'bold', cls: 'font-bold' },
		{ label: 'I', title: 'Italic (Ctrl+I)', on: () => run('italic'), key: 'italic', cls: 'italic' },
		{
			label: 'U',
			title: 'Underline (Ctrl+U)',
			on: () => run('underline'),
			key: 'underline',
			cls: 'underline'
		},
		{
			label: 'S',
			title: 'Strikethrough',
			on: () => run('strikeThrough'),
			key: 'strikeThrough',
			cls: 'line-through'
		},
		{ label: 'ab', title: 'Highlight', on: () => wrap('mark'), key: 'mark', cls: 'highlight' },
		{
			label: 'x²',
			title: 'Superscript (Ctrl+Shift+=)',
			on: () => run('superscript'),
			key: 'superscript'
		},
		{ label: 'x₂', title: 'Subscript (Ctrl+=)', on: () => run('subscript'), key: 'subscript' },
		{
			label: '</>',
			title: 'Inline code',
			on: () => wrap('code'),
			key: 'code',
			cls: 'font-mono text-[11px]'
		},
		'|',
		{ label: '•', title: 'Bulleted list', on: () => toList('bullet'), key: 'bullet' },
		{ label: '–', title: 'Dashed list', on: () => toList('dash'), key: 'dash' },
		{ label: '1.', title: 'Numbered list', on: () => toList('number'), key: 'number' },
		'|',
		{ label: '↗', title: 'Link (Ctrl+K)', on: openLink, key: 'link' },
		{ label: 'T̸', title: 'Clear formatting', on: () => run('removeFormat') }
	];

	const STYLES = [
		{ tag: 'h3', label: 'Heading', cls: 'font-semibold text-base' },
		{ tag: 'h4', label: 'Subheading', cls: 'font-semibold' },
		{ tag: 'div', label: 'Body', cls: '' },
		{ tag: 'pre', label: 'Monospaced', cls: 'font-mono text-xs' }
	];
	const styled = (tag: string) =>
		tag === 'div' ? !['h3', 'h4', 'pre'].includes(block) : block === tag;
	const pressed = (key?: string) => (key ? Boolean(key === list || on[key]) : undefined);
</script>

<!-- Buttons keep focus in the field: a mousedown that moved it would drop the selection first. -->
<div data-format-bar class="w-full space-y-2 {field ? '' : 'max-lg:hidden'}">
	{#if panel === 'styles'}
		<div class="flex flex-wrap gap-1" role="group" aria-label="Text styles">
			{#each STYLES as s (s.tag)}
				<button
					type="button"
					class="btn min-h-11 px-3 py-1 text-sm lg:min-h-8 {s.cls}"
					aria-pressed={styled(s.tag)}
					class:!bg-accent-soft={styled(s.tag)}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => style(s.tag)}>{s.label}</button
				>
			{/each}
			<button
				type="button"
				class="btn min-h-11 px-3 py-1 text-sm lg:min-h-8"
				title="Outdent (Shift+Tab)"
				disabled={!list}
				onmousedown={(e) => e.preventDefault()}
				onclick={() => indent(true)}>⇤ Outdent</button
			>
			<button
				type="button"
				class="btn min-h-11 px-3 py-1 text-sm lg:min-h-8"
				title="Indent (Tab)"
				disabled={!list}
				onmousedown={(e) => e.preventDefault()}
				onclick={() => indent(false)}>Indent ⇥</button
			>
		</div>
	{:else if panel === 'link'}
		<div class="flex flex-wrap items-center gap-1">
			<label for="format-link" class="sr-only">Link address</label>
			<input
				bind:this={linkInput}
				id="format-link"
				class="input min-h-11 min-w-0 flex-1 text-sm lg:min-h-8 lg:py-1"
				type="url"
				inputmode="url"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="done"
				placeholder="example.com or name@example.com"
				aria-invalid={url.trim() !== '' && !href}
				bind:value={url}
				onkeydown={(e) => {
					// Enter would submit the card, and Escape would close it.
					if (e.key === 'Enter') {
						e.preventDefault();
						applyLink();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						closeLink();
					}
				}}
			/>
			<button
				type="button"
				class="btn btn-primary min-h-11 px-3 py-1 text-sm lg:min-h-8"
				disabled={!href}
				onclick={applyLink}>{on.link ? 'Update' : 'Add link'}</button
			>
			{#if on.link}
				<button type="button" class="btn min-h-11 px-3 py-1 text-sm lg:min-h-8" onclick={unlink}
					>Remove</button
				>
			{/if}
			<button
				type="button"
				class="btn btn-ghost min-h-11 px-3 py-1 text-sm lg:min-h-8"
				onclick={closeLink}>Cancel</button
			>
		</div>
	{/if}

	<div
		class="-mx-1 flex gap-1 overflow-x-auto px-1 max-lg:[scrollbar-width:none] lg:flex-wrap"
		role="toolbar"
		aria-label="Formatting"
		aria-controls={field?.id}
	>
		<button
			type="button"
			class="btn min-h-11 min-w-11 shrink-0 px-2 py-1 text-sm lg:min-h-8 lg:min-w-8"
			title="Text styles and indent"
			aria-label="Text styles and indent"
			aria-expanded={panel === 'styles'}
			class:!bg-accent-soft={panel === 'styles'}
			disabled={!field}
			onmousedown={(e) => e.preventDefault()}
			onclick={() => (panel = panel === 'styles' ? null : 'styles')}>Aa</button
		>
		{#each TOOLS as t, i (typeof t === 'string' ? i : t.title)}
			{#if typeof t === 'string'}
				<span class="bg-line my-2 w-px shrink-0" aria-hidden="true"></span>
			{:else}
				<button
					type="button"
					class="btn min-h-11 min-w-11 shrink-0 px-2 py-1 text-sm lg:min-h-8 lg:min-w-8 {t.cls ??
						''}"
					class:!bg-accent-soft={pressed(t.key)}
					title={t.title}
					aria-label={t.title}
					aria-pressed={pressed(t.key)}
					disabled={!field}
					onmousedown={(e) => e.preventDefault()}
					onclick={t.on}>{t.label}</button
				>
			{/if}
		{/each}
	</div>
</div>

<style>
	.highlight {
		background-image: linear-gradient(
			transparent 55%,
			color-mix(in srgb, var(--hard) 45%, transparent) 55%
		);
	}
</style>
