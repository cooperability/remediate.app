<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CircleUserRound from '@lucide/svelte/icons/circle-user-round';
	import Link from '@lucide/svelte/icons/link';
	import LogOut from '@lucide/svelte/icons/log-out';

	let { email, guest = false }: { email: string; guest?: boolean } = $props();
	const label = $derived(guest ? 'Demo guest' : email);

	let root: HTMLDetailsElement | undefined = $state();
	// Not on enter: that is hydration, and a menu opened before it must stay open.
	afterNavigate(({ type }) => {
		if (type !== 'enter' && root) root.open = false;
	});
</script>

<!-- details, so the menu and its Log out form work before hydration and without JS. -->
<!-- pointerdown: iOS sends no click to the window for a tap on plain content. -->
<svelte:window
	onpointerdown={(e) => {
		if (root?.open && e.target instanceof Node && !root.contains(e.target)) root.open = false;
	}}
	onkeydown={(e) => {
		if (!root?.open || e.key !== 'Escape') return;
		// Claimed, so the card editor's own Escape leaves the card open.
		e.preventDefault();
		root.open = false;
		root.querySelector('summary')?.focus();
	}}
/>

<details class="relative" bind:this={root}>
	<summary
		class="btn btn-ghost text-muted hover:text-fg size-11 list-none p-0 [&::-webkit-details-marker]:hidden"
		aria-label="Account"
		title={label}
	>
		<CircleUserRound class="size-5" />
	</summary>
	<div class="panel absolute right-0 z-30 mt-2 w-64 p-1.5 shadow-xl">
		<p class="text-muted truncate px-3 pt-2 pb-2.5 font-mono text-xs">{label}</p>
		{#if !guest}
			<a href={resolve('/harvest')} class="item">
				<Link class="size-4" /> Harvest links
			</a>
		{/if}
		<form method="POST" action="/login?/logout">
			<button class="item w-full">
				<LogOut class="size-4" /> Log out
			</button>
		</form>
	</div>
</details>

<style>
	.item {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		gap: 0.75rem;
		border-radius: 0.6rem;
		padding-inline: 0.75rem;
		font-size: 0.875rem;
		text-align: left;
	}
	.item:hover {
		background: var(--surface-2);
	}
	.item :global(svg) {
		color: var(--muted);
	}
</style>
