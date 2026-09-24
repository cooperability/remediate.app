<script lang="ts">
	import { resolve } from '$app/paths';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import Encounter from '$lib/components/quest/Encounter.svelte';
	import QuestMap from '$lib/components/quest/QuestMap.svelte';
	import RoomPanel from '$lib/components/quest/RoomPanel.svelte';
	import type { Door, EncounterCard, MapNode, Outcome, QuestView } from '$lib/quest/types';

	let { data } = $props();

	// The page is a small client: the server owns the rules and every decision,
	// and each call returns the state to draw next.
	// Seeded from the load, then replaced by each API answer. Writable deriveds, so
	// a fresh load (navigating back here) reseeds them.
	let view = $derived<QuestView | null>(data.view);
	let encounter = $derived<EncounterCard | null>(data.view?.encounter ?? null);
	let busy = $state(false);
	let notice = $state<{ text: string; tone: 'info' | 'error' } | null>(null);
	let now = $state(new Date());
	let mapRef: QuestMap | undefined = $state();
	let panel: HTMLElement | undefined = $state();
	const still = $derived(prefersReducedMotion.current);

	// Keep "opens in 8 min" honest while the page sits open.
	$effect(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	const doorIds = $derived(new Set(view?.room.doors.map((d) => d.to) ?? []));
	const nextLocked = $derived(view?.room.doors.find((d) => d.status === 'locked') ?? null);
	const lockedCount = $derived(view?.room.doors.filter((d) => d.status === 'locked').length ?? 0);

	class Refused extends Error {}

	async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		const res = await fetch(path, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined
		});
		if (res.status === 401) throw new Error('Your session ended. Log in again.');
		const json = await res.json().catch(() => null);
		if (res.status === 409) throw new Refused(json?.message ?? 'Not from here.');
		if (!res.ok) throw new Error(json?.message ?? `${path} ${res.status}`);
		return json as T;
	}

	function say(text: string, tone: 'info' | 'error' = 'info') {
		notice = { text, tone };
	}

	async function run(task: () => Promise<void>) {
		if (busy) return;
		busy = true;
		notice = null;
		try {
			await task();
		} catch (e) {
			say(e instanceof Error ? e.message : String(e), e instanceof Refused ? 'info' : 'error');
		} finally {
			busy = false;
		}
	}

	function arrive(next: QuestView) {
		view = next;
		now = new Date();
		// A new room reads from the top.
		panel?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
	}

	const go = (to: string) =>
		run(async () => arrive(await call<QuestView>('POST', '/api/quest/move', { to })));

	const challenge = (to: string) =>
		run(async () => {
			encounter = await call<EncounterCard>('POST', '/api/quest/encounter', { to });
		});

	function ondoor(d: Door) {
		if (d.status === 'open') go(d.to);
		else if (d.status === 'locked') challenge(d.to);
	}

	function onselect(n: MapNode) {
		if (!view || n.id === view.map.current) return;
		const door = view.room.doors.find((d) => d.to === n.id);
		if (door) return ondoor(door);
		// Off the room's doors: fast travel over known ground, or a rematch for a lapsed card.
		if (n.open) go(n.id);
		else challenge(n.id);
	}

	async function grade(rating: number): Promise<Outcome> {
		const e = encounter!;
		return call<Outcome>('POST', '/api/review/grade', {
			encounterId: e.encounterId,
			nodeId: e.nodeId,
			rating
		});
	}

	async function closeEncounter(entered: boolean) {
		encounter = null;
		await run(async () => arrive(await call<QuestView>('GET', '/api/quest')));
		if (entered) say('You are in. Its tags are on the map now.');
	}

	function onkeydown(e: KeyboardEvent) {
		if (encounter || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
		if (e.key === 'n' && nextLocked) {
			e.preventDefault();
			challenge(nextLocked.to);
		} else if (e.key === 'f') mapRef?.focus();
		else if (e.key === 'm') mapRef?.fit();
	}
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>{view ? `${view.room.title} · Quest` : 'Quest'} · Remediate</title>
</svelte:head>

{#if !view}
	<main class="mx-auto max-w-xl px-4 py-16 text-center">
		<p class="eyebrow">Quest</p>
		<h1 class="mt-2 text-2xl font-bold tracking-tight">Your map is empty</h1>
		<p class="mt-3 text-muted">
			Quest draws a world from your cards: every deck is a hall, every tag a passage, every card a
			room you open by recalling it. Import a deck to begin.
		</p>
		<a class="btn btn-primary mt-6" href={resolve('/cards')}>Import a deck</a>
	</main>
{:else}
	<div class="quest mx-auto flex max-w-7xl flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-row">
		<section
			class="relative h-[46dvh] min-h-64 border-b border-line lg:h-auto lg:flex-1 lg:border-r lg:border-b-0"
		>
			<QuestMap bind:this={mapRef} map={view.map} doors={doorIds} {onselect} />

			<div
				class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3"
			>
				<dl class="stats pointer-events-auto">
					<div>
						<dt>Known</dt>
						<dd>{view.map.stats.cardsKnown}<span>/{view.map.stats.cardsTotal}</span></dd>
					</div>
					<div>
						<dt>Found</dt>
						<dd>{view.map.stats.conceptsFound}<span>/{view.map.stats.conceptsTotal}</span></dd>
					</div>
				</dl>
				<div class="pointer-events-auto flex gap-1.5">
					<button
						class="btn map-btn"
						onclick={() => mapRef?.focus()}
						title="Find me (F)"
						aria-label="Center on your room"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"
							><circle cx="8" cy="8" r="2.5" /><path
								d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"
							/></svg
						>
					</button>
					<button
						class="btn map-btn"
						onclick={() => mapRef?.fit()}
						title="Whole map (M)"
						aria-label="Show the whole map"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"
							><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></svg
						>
					</button>
				</div>
			</div>

			<ul
				class="legend pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1"
			>
				<li><i class="solid"></i>Known</li>
				<li><i class="fading"></i>Fading</li>
				<li><i class="lapsed"></i>Lapsed</li>
				<li><i class="hall"></i>Hall / tag</li>
			</ul>
		</section>

		<aside
			bind:this={panel}
			class="flex flex-col lg:w-[26rem] lg:overflow-y-auto"
			aria-label="The room you are in"
		>
			<div class="flex-1 px-4 py-5">
				{#if notice}
					<p
						class="panel mb-4 px-4 py-2.5 text-sm"
						class:error={notice.tone === 'error'}
						role={notice.tone === 'error' ? 'alert' : 'status'}
						in:fly={{ y: still ? 0 : -6, duration: 160 }}
					>
						{notice.text}
					</p>
				{/if}
				{#key view.room.id}
					<div in:fly={{ x: still ? 0 : 16, duration: still ? 0 : 200 }}>
						<RoomPanel room={view.room} {busy} {now} {ondoor} />
					</div>
				{/key}
			</div>

			{#if nextLocked}
				<div class="sticky bottom-0 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur">
					<button
						class="btn btn-primary w-full py-3 text-base"
						disabled={busy}
						onclick={() => challenge(nextLocked.to)}
					>
						Next encounter
						<span class="font-mono text-xs opacity-75">{lockedCount} locked</span>
						<span class="kbd hidden border-transparent bg-black/15 text-current sm:inline-flex"
							>N</span
						>
					</button>
				</div>
			{/if}
		</aside>
	</div>
{/if}

{#if encounter}
	<Encounter {encounter} onrate={grade} onclose={closeEncounter} />
{/if}

<div class="sr-only" aria-live="polite">{view ? `You are in ${view.room.title}.` : ''}</div>

<style>
	.stats {
		display: flex;
		gap: 0.5rem;
	}
	.stats > div {
		border: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface) 88%, transparent);
		backdrop-filter: blur(6px);
		border-radius: 0.75rem;
		padding: 0.3rem 0.65rem;
	}
	.stats dt {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.stats dd {
		font-family: var(--font-mono);
		font-size: 0.95rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.stats dd span {
		color: var(--muted);
		font-weight: 400;
		font-size: 0.75rem;
	}
	.map-btn {
		height: 44px;
		width: 44px;
		padding: 0;
		background: color-mix(in srgb, var(--surface) 88%, transparent);
		backdrop-filter: blur(6px);
	}
	.map-btn svg {
		height: 1.1rem;
		width: 1.1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.legend {
		font-size: 11px;
		color: var(--muted);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.legend i {
		display: inline-block;
		height: 0.55rem;
		width: 0.55rem;
		border-radius: 9999px;
	}
	.legend .solid {
		background: var(--good);
	}
	.legend .fading {
		background: var(--hard);
	}
	.legend .lapsed {
		border: 1.5px solid var(--again);
	}
	.legend .hall {
		background: var(--surface-2);
		border: 1.5px solid var(--fg);
	}
	.error {
		border-color: color-mix(in srgb, var(--again) 40%, transparent);
		background: color-mix(in srgb, var(--again) 10%, transparent);
	}
</style>
