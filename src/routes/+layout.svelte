<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { invalidateAll, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
	import { resolve } from '$app/paths';
	import { splashScreens } from '$lib/pwa/splash';
	import Logo from '$lib/components/brand/Logo.svelte';
	import ThemeToggle from '$lib/components/brand/ThemeToggle.svelte';
	import AccountMenu from '$lib/components/nav/AccountMenu.svelte';
	import TabBar from '$lib/components/nav/TabBar.svelte';
	import { VIEWS } from '$lib/components/nav/views';

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

	// Crossfade between pages. Same-path navigations (search, filters, the editor's
	// ?card=) swap in place: a fade on every keystroke would only flicker.
	onNavigate((nav) => {
		if (!document.startViewTransition || prefersReducedMotion.current) return;
		if (nav.from?.url.pathname === nav.to?.url.pathname) return;
		return new Promise((done) => {
			document.startViewTransition(async () => {
				done();
				await nav.complete;
			});
		});
	});
</script>

<!-- iOS reads these when a page is added to the Home Screen, so every page carries them. -->
<svelte:head>
	{#each splashScreens as s (s.href)}
		<link rel="apple-touch-startup-image" href={s.href} media={s.media} />
	{/each}
</svelte:head>

<div class="bg-bg text-fg min-h-dvh" class:has-tabbar={data.user && !focus}>
	{#if data.user && !focus}
		<!-- relative on phones too: the account menu must paint over the page below the bar. -->
		<nav
			class="topbar border-line bg-bg/80 relative z-20 border-b backdrop-blur-md sm:sticky sm:top-0"
		>
			<div class="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-6">
				<a href={resolve('/cards')} aria-label="Remediate decks" class="mr-auto sm:mr-0"><Logo /></a
				>
				<!-- Phones carry these in the tab bar at the bottom of the screen. -->
				<ul class="hidden items-center gap-1 sm:flex">
					{#each VIEWS as v (v.href)}
						<li>
							<a
								href={resolve(v.href)}
								class="text-muted hover:text-fg aria-[current=page]:bg-surface-2 aria-[current=page]:text-fg inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors"
								aria-current={v.match(page.url.pathname) ? 'page' : undefined}
							>
								<v.icon class="size-4" />
								{v.label}
							</a>
						</li>
					{/each}
				</ul>
				<div class="flex items-center gap-1 sm:ml-auto sm:gap-2">
					<ThemeToggle theme={data.theme} />
					<AccountMenu email={data.user.email} guest={data.user.guest} />
				</div>
			</div>
		</nav>
		{#if data.user.guest}
			<p class="border-line bg-accent-soft border-b px-4 py-2 text-center text-sm">
				Demo with two AI-made decks. Progress is wiped within 24 hours.
				<a href={resolve('/login')} class="text-accent font-medium underline">Log in</a>
			</p>
		{/if}
	{:else if !data.user && !focus}
		<div
			class="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-20"
		>
			<ThemeToggle theme={data.theme} />
		</div>
	{/if}
	{@render children()}
	{#if data.user && !focus}<TabBar />{/if}
</div>

<style>
	/* Held still only where it is sticky. On phones it scrolls away, and a named layer
	   would slide back down from wherever it was. */
	@media (min-width: 640px) {
		.topbar {
			view-transition-name: topbar;
		}
	}
</style>
