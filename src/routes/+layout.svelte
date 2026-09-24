<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
	import { resolve } from '$app/paths';
	import Logo from '$lib/components/brand/Logo.svelte';
	import ThemeToggle from '$lib/components/brand/ThemeToggle.svelte';

	let { data, children } = $props();

	// Report the browser's time zone so days, streaks and the new-card cap follow
	// the user's calendar. Reload the data once when it changes.
	onMount(() => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		// Compare what the server would accept, so an unusable zone cannot reload every visit.
		if (!tz || toTimeZone(tz) === data.timeZone) return;
		document.cookie = `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
		if (data.user) invalidateAll();
	});

	// The study screen is a focus mode: it carries its own minimal header.
	const focus = $derived(page.url.pathname.startsWith('/cards/study'));
</script>

<div class="bg-bg text-fg min-h-dvh">
	{#if data.user && !focus}
		<nav class="border-line bg-bg/80 sticky top-0 z-20 border-b backdrop-blur">
			<div class="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6">
				<!-- Below 420px the wordmark gives way so Quest and Log out stay on one line. -->
				<a
					href={resolve('/cards')}
					aria-label="Remediate decks"
					class="max-[419px]:[&_span_span]:hidden"><Logo /></a
				>
				<!-- Phones drop this duplicate of the logo link to fit Log out and the theme toggle. -->
				<a
					href={resolve('/cards')}
					class="text-muted hover:text-fg hidden text-sm sm:inline"
					aria-current={page.url.pathname === '/cards' ? 'page' : undefined}>Decks</a
				>
				<a
					href={resolve('/quest')}
					class="text-sm text-muted hover:text-fg aria-[current=page]:text-fg"
					aria-current={page.url.pathname === '/quest' ? 'page' : undefined}>Quest</a
				>
				<form method="POST" action="/login?/logout" class="ml-auto flex items-center gap-3">
					<span class="text-muted hidden font-mono text-xs sm:inline">{data.user.email}</span>
					<button class="btn btn-ghost whitespace-nowrap">Log out</button>
				</form>
				<ThemeToggle theme={data.theme} />
			</div>
		</nav>
	{:else if !data.user && !focus}
		<div class="fixed right-4 bottom-4 z-20"><ThemeToggle theme={data.theme} /></div>
	{/if}
	{@render children()}
</div>
