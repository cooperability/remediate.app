<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Logo from '$lib/components/brand/Logo.svelte';
	import DemoRound from '$lib/components/study/DemoRound.svelte';

	let { data } = $props();

	// Set by POST /demo when it could not start a guest.
	const demoRefused = $derived(
		{
			full: 'The demo is full right now. Try again later.',
			throttled: 'Too many demos started from your network. Try again in an hour.'
		}[page.url.searchParams.get('demo') ?? '']
	);

	let flipped = $state(false);
	let hovering = $state(false);

	$effect(() => {
		if (hovering) return;
		const id = setInterval(() => (flipped = !flipped), 3200);
		return () => clearInterval(id);
	});

	// Sample per-tag grading artifact for the strip visual: share of cards answered well.
	const tags = [
		{ tag: 'sql', score: 0.9 },
		{ tag: 'regex', score: 0.35 },
		{ tag: 'git', score: 0.7 },
		{ tag: 'dns', score: 0.25 }
	];
</script>

<svelte:head>
	<title>Remediate</title>
	<meta
		name="description"
		content="Remediate turns your Anki decks into spaced repetition rounds that aim at your weak areas."
	/>
	<!-- The apex redirects to www, so previews and search index the www URL. -->
	<link rel="canonical" href="https://www.remediate.app/" />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://www.remediate.app/" />
	<meta property="og:title" content="Remediate" />
	<meta
		property="og:description"
		content="Remediate turns your Anki decks into spaced repetition rounds that aim at your weak areas."
	/>
	<meta property="og:image" content="https://www.remediate.app/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta
		property="og:image:alt"
		content="Remediate. A flashcard asking which git command replays commits onto a new base."
	/>
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<div class="backdrop relative min-h-dvh overflow-hidden">
	<header class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
		<a href={resolve('/')} aria-label="Remediate home"><Logo /></a>
		{#if data.user}
			<a href={resolve('/cards')} class="btn btn-ghost">Open decks</a>
		{:else}
			<a href={resolve('/login')} class="btn btn-ghost">Log in</a>
		{/if}
	</header>

	<main class="mx-auto max-w-6xl px-4 pb-24">
		<section class="grid items-center gap-12 pt-10 sm:pt-16 lg:grid-cols-[1.15fr_1fr]">
			<div>
				<p class="eyebrow">re·me·di·ate &nbsp;/ to fix a gap /</p>
				<h1 class="mt-4 text-5xl leading-[0.95] font-bold tracking-tight text-balance sm:text-7xl">
					Remediate<span class="text-accent">.</span>
				</h1>
				<p class="text-muted mt-6 max-w-xl text-lg sm:text-xl">
					Find what you do not know, then fix it. Your Anki decks become spaced repetition rounds
					that grade themselves by tag and aim the next round at your weak spots.
				</p>
				<div class="mt-8 flex flex-wrap items-center gap-3">
					{#if data.user}
						<a href={resolve('/cards')} class="btn btn-primary px-6 py-3 text-base">Open decks</a>
					{:else}
						<form method="POST" action="/demo">
							<button class="btn btn-primary px-6 py-3 text-base">Try the demo</button>
						</form>
						<a href={resolve('/login')} class="btn btn-ghost px-6 py-3 text-base">Log in</a>
					{/if}
				</div>
				{#if data.user}
					<p class="text-muted mt-3 font-mono text-xs">Invite only. Passwordless email code.</p>
				{:else}
					<p class="text-muted mt-3 max-w-xl text-sm">
						No account needed. The demo opens two AI-made decks, software and personal finance with
						career growth, in the full app: browse, study and Quest. It is wiped within 24 hours.
					</p>
				{/if}
				{#if demoRefused}
					<p class="text-again mt-3 text-sm" role="alert">{demoRefused}</p>
				{/if}
			</div>

			<!-- Demo card: flips on a timer, and holds the answer on hover. -->
			<div
				class="card-scene mx-auto w-full max-w-sm"
				role="img"
				aria-label="Sample flashcard. Question: Which git command replays commits onto a new base? Answer: git rebase."
				onmouseenter={() => ((hovering = true), (flipped = true))}
				onmouseleave={() => (hovering = false)}
			>
				<div class="card-inner" class:flipped>
					<div class="card-face panel p-6">
						<div class="flex items-center justify-between">
							<span class="chip">git</span>
							<span class="eyebrow">Question</span>
						</div>
						<p class="mt-10 text-2xl leading-snug font-semibold">
							Which command replays your commits onto a new base?
						</p>
						<p class="text-muted mt-auto flex items-center gap-2 pt-8 text-xs">
							Recall it, then flip
						</p>
					</div>
					<div class="card-face card-back panel p-6">
						<div class="flex items-center justify-between">
							<span class="chip">git</span>
							<span class="eyebrow">Answer</span>
						</div>
						<p class="text-accent mt-10 font-mono text-3xl font-semibold">git rebase</p>
						<div class="mt-auto grid grid-cols-4 gap-1.5 pt-8 text-center text-xs font-medium">
							<span class="bg-again/15 text-again rounded-lg py-1.5">Again</span>
							<span class="bg-hard/15 text-hard rounded-lg py-1.5">Hard</span>
							<span class="bg-good/15 text-good rounded-lg py-1.5">Good</span>
							<span class="bg-easy/15 text-easy rounded-lg py-1.5">Easy</span>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section class="mt-24" aria-labelledby="try-heading">
			<p class="eyebrow">Try it</p>
			<h2 id="try-heading" class="mt-2 text-3xl font-bold tracking-tight">
				Study a five-card round.
			</h2>
			<p class="text-muted mt-2 max-w-xl">
				The same study screen signed-in decks use. Flip with Space, grade with 1 to 4. Answer Again
				and the card comes back before the round ends. Nothing is saved.
			</p>
			<div class="mt-8 max-w-3xl">
				<DemoRound />
			</div>
		</section>

		<section class="mt-24" aria-labelledby="round-heading">
			<p class="eyebrow">How a round works</p>
			<h2 id="round-heading" class="mt-2 text-3xl font-bold tracking-tight">
				Every round sets up the next one.
			</h2>
			<ol class="mt-8 grid gap-4 md:grid-cols-3">
				<li class="panel flex flex-col p-5">
					<span class="text-accent font-mono text-xs">01</span>
					<h3 class="mt-2 text-lg font-semibold">Study</h3>
					<p class="text-muted mt-1 text-sm">
						Pick a deck. FSRS puts due cards first, then spreads new cards across tags and
						interleaves them.
					</p>
					<div class="mt-auto flex gap-1.5 pt-6" aria-hidden="true">
						{#each ['due', 'due', 'new', 'due', 'new', 'due'] as kind, i (i)}
							<span
								class="h-8 flex-1 rounded-md {kind === 'due'
									? 'bg-accent'
									: 'border-line bg-surface-2 border border-dashed'}"
							></span>
						{/each}
					</div>
				</li>
				<li class="panel flex flex-col p-5">
					<span class="text-accent font-mono text-xs">02</span>
					<h3 class="mt-2 text-lg font-semibold">Grade</h3>
					<p class="text-muted mt-1 text-sm">
						Your answers roll up into a grading artifact: each tag marked strong or weak.
					</p>
					<div class="mt-auto space-y-1.5 pt-6" aria-hidden="true">
						{#each tags as t (t.tag)}
							<div class="flex items-center gap-2">
								<span class="text-muted w-10 font-mono text-[11px]">{t.tag}</span>
								<span class="bg-surface-2 h-2 flex-1 overflow-hidden rounded-full">
									<span
										class="block h-full rounded-full {t.score >= 0.5 ? 'bg-good' : 'bg-again'}"
										style="width: {t.score * 100}%"
									></span>
								</span>
							</div>
						{/each}
					</div>
				</li>
				<li class="panel flex flex-col p-5">
					<span class="text-accent font-mono text-xs">03</span>
					<h3 class="mt-2 text-lg font-semibold">Next round targets weak areas</h3>
					<p class="text-muted mt-1 text-sm">
						Weak tags get boosted. Strong tags get a few probes to confirm they stay strong.
					</p>
					<div class="mt-auto flex h-14 items-end gap-1.5 pt-6" aria-hidden="true">
						{#each tags as t (t.tag)}
							<span
								class="flex-1 rounded-md {t.score >= 0.5 ? 'bg-surface-2' : 'bg-accent'}"
								style="height: {Math.round((1.15 - t.score) * 100)}%"
							></span>
						{/each}
					</div>
				</li>
			</ol>
		</section>

		<section class="mt-16" aria-labelledby="coming-heading">
			<h2 id="coming-heading" class="eyebrow">Coming, not built yet</h2>
			<div class="mt-4 grid gap-4 sm:grid-cols-2">
				<div class="panel border-dashed p-5">
					<div class="flex items-center gap-2">
						<h3 class="font-semibold">BMX harvest</h3>
						<span class="chip">coming</span>
					</div>
					<p class="text-muted mt-1 text-sm">Bookmarks pulled into the graph beside your cards.</p>
				</div>
			</div>
		</section>
	</main>

	<footer
		class="border-line text-muted mx-auto flex max-w-6xl items-center justify-between border-t px-4 py-6 text-xs"
	>
		<Logo size={18} />
		<span class="font-mono">FSRS scheduling</span>
	</footer>
</div>

<style>
	.backdrop {
		background-image:
			radial-gradient(ellipse 60% 50% at 70% 0%, var(--accent-soft), transparent 70%),
			linear-gradient(var(--line) 1px, transparent 1px),
			linear-gradient(90deg, var(--line) 1px, transparent 1px);
		background-size:
			100% 100%,
			48px 48px,
			48px 48px;
		background-position:
			0 0,
			-1px -1px,
			-1px -1px;
	}
	.backdrop::before {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: linear-gradient(to bottom, transparent, var(--bg) 85%);
		z-index: 0;
	}
	.backdrop::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0.06;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
	}
	.backdrop > :global(*) {
		position: relative;
		z-index: 1;
	}

	.card-scene {
		perspective: 1200px;
		aspect-ratio: 4 / 3.4;
	}
	.card-inner {
		position: relative;
		height: 100%;
		transform-style: preserve-3d;
		transition: transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.card-inner.flipped {
		transform: rotateY(180deg);
	}
	.card-face {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		backface-visibility: hidden;
		box-shadow:
			var(--glow),
			0 24px 60px -30px rgb(0 0 0 / 0.35);
	}
	.card-back {
		transform: rotateY(180deg);
	}
</style>
