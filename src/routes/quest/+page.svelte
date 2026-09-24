<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import Encounter from '$lib/components/quest/Encounter.svelte';
	import QuestMap from '$lib/components/quest/QuestMap.svelte';
	import RoomPanel from '$lib/components/quest/RoomPanel.svelte';
	import TravelList from '$lib/components/quest/TravelList.svelte';
	import { percent } from '$lib/quest/format';
	import type { Door, EncounterCard, MapNode, Outcome, QuestView } from '$lib/quest/types';

	let { data } = $props();

	// The page is a small client: the server owns the rules and every decision,
	// and each call returns the state to draw next. Seeded from the load, then
	// replaced by each answer. Writable deriveds, so a fresh load reseeds them.
	let view = $derived<QuestView | null>(data.view);
	let encounter = $derived<EncounterCard | null>(data.view?.encounter ?? null);
	let busy = $state(false);
	let notice = $state<{ text: string; tone: 'info' | 'error'; login?: boolean } | null>(null);
	let now = $state(new Date());
	let selected = $state<string | null>(null);
	let flash = $state<string | null>(null);
	let mapRef: QuestMap | undefined = $state();
	let panel: HTMLElement | undefined = $state();
	/** Where focus was when an encounter opened, to return it there. */
	let opener: HTMLElement | null = null;
	const still = $derived(prefersReducedMotion.current);

	// Keep "opens in 8 min" honest while the page sits open.
	$effect(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	// When the soonest sealed door reopens, ask the server again: the button is
	// disabled until the server says the door is locked (an encounter) instead.
	$effect(() => {
		const soonest = Math.min(
			...(view?.room.doors ?? [])
				.filter((d) => d.status === 'sealed' && d.retryAt)
				.map((d) => new Date(d.retryAt!).getTime())
		);
		if (!Number.isFinite(soonest)) return;
		const wait = Math.max(1000, soonest - Date.now() + 1000);
		if (wait > 3_600_000) return;
		const t = setTimeout(() => refresh(), wait);
		return () => clearTimeout(t);
	});

	// A notice clears itself after a while; errors stay until the next action.
	$effect(() => {
		if (!notice || notice.tone === 'error') return;
		const t = setTimeout(() => (notice = null), 6000);
		return () => clearTimeout(t);
	});

	$effect(() => {
		if (!flash) return;
		const t = setTimeout(() => (flash = null), 1600);
		return () => clearTimeout(t);
	});

	const doorIds = $derived(new Set(view?.room.doors.map((d) => d.to) ?? []));
	const picked = $derived(selected ? view?.map.nodes.find((n) => n.id === selected) : undefined);

	class Refused extends Error {}
	class SignedOut extends Error {}

	async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		let res: Response;
		try {
			res = await fetch(path, {
				method,
				headers: body ? { 'content-type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
		} catch {
			throw new Error('You look offline. Check the connection and try again.');
		}
		if (res.status === 401) throw new SignedOut('Your session ended.');
		const json = await res.json().catch(() => null);
		if (res.status === 409) throw new Refused(json?.message ?? 'Not from here.');
		if (!res.ok)
			throw new Error(json?.message ?? `Something went wrong (${res.status}). Try again.`);
		if (json === null) throw new Error('The server sent something unexpected. Try again.');
		return json as T;
	}

	function say(text: string, tone: 'info' | 'error' = 'info', login = false) {
		notice = { text, tone, login };
	}

	async function run(task: () => Promise<void>) {
		if (busy) return;
		busy = true;
		notice = null;
		try {
			await task();
		} catch (e) {
			const text = e instanceof Error ? e.message : String(e);
			say(text, e instanceof Refused ? 'info' : 'error', e instanceof SignedOut);
		} finally {
			busy = false;
		}
	}

	/** Draw the next state; a new room reads from the top, with focus on its title. */
	async function arrive(next: QuestView, focusTitle = true) {
		const moved = next.room.id !== view?.room.id;
		view = next;
		now = new Date();
		// A tap on the map stays picked through a refresh in place, not through a move.
		if (moved || !next.map.nodes.some((n) => n.id === selected)) selected = null;
		if (!moved) return;
		panel?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
		if (focusTitle) {
			await tick();
			document.getElementById('room-title')?.focus();
		}
	}

	/**
	 * Redraw from the server in the background, when a sealed door reopens. Not
	 * through run(): it would clear the toast the player is reading, and be dropped
	 * outright while another request is in flight. A failure here is not the
	 * player's to see; the next action reports it.
	 */
	async function refresh() {
		if (busy || encounter) {
			setTimeout(refresh, 2000);
			return;
		}
		try {
			const next = await call<QuestView>('GET', '/api/quest');
			if (!busy && !encounter) await arrive(next, false);
		} catch {
			// Stay on the current view.
		}
	}

	const go = (to: string) =>
		run(async () => arrive(await call<QuestView>('POST', '/api/quest/move', { to })));

	function remember() {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}

	const challenge = (to: string) =>
		run(async () => {
			remember();
			encounter = await call<EncounterCard>('POST', '/api/quest/encounter', { to });
		});

	const next = () =>
		run(async () => {
			remember();
			const r = await call<{ encounter: EncounterCard; view: QuestView }>(
				'POST',
				'/api/quest/next'
			);
			await arrive(r.view, false);
			encounter = r.encounter;
		});

	function ondoor(d: Door) {
		if (d.status === 'locked' || d.due) challenge(d.to);
		else if (d.status === 'open') go(d.to);
	}

	/** Travel or face whatever a map node is: its door from here, or fast travel. */
	function act(n: MapNode) {
		const door = view?.room.doors.find((d) => d.to === n.id);
		if (door) return ondoor(door);
		if (n.open) go(n.id);
		else challenge(n.id);
	}

	function describe(n: MapNode): { text: string; action: string | null } {
		const door = view?.room.doors.find((d) => d.to === n.id);
		if (n.id === view?.map.current) return { text: 'You are here', action: null };
		if (n.facet !== 'card') {
			const share = n.strength === null ? '' : ` · ${percent(n.strength)} known`;
			return { text: `${n.facet === 'deck' ? 'Deck hall' : 'Tag'}${share}`, action: 'Go' };
		}
		if (door?.status === 'locked') return { text: 'Locked door from here', action: 'Recall' };
		if (door?.due) return { text: 'Known, due for review', action: 'Review' };
		if (door?.status === 'sealed') return { text: 'Sealed for now', action: null };
		if (n.open) return { text: `Known · recall now ${percent(n.strength)}`, action: 'Go' };
		return { text: 'Lapsed: recall it to reopen', action: 'Rematch' };
	}

	async function grade(rating: number): Promise<Outcome> {
		const e = encounter!;
		return call<Outcome>('POST', '/api/review/grade', {
			encounterId: e.encounterId,
			nodeId: e.nodeId,
			rating
		});
	}

	async function closeEncounter(outcome: Outcome | null) {
		const nodeId = encounter?.nodeId;
		encounter = null;
		await run(async () => arrive(await call<QuestView>('GET', '/api/quest'), false));
		await tick();
		if (outcome?.unlocked && nodeId) {
			flash = nodeId;
			const cleared = outcome.cleared?.length ? ` Cleared: ${outcome.cleared.join(', ')}.` : '';
			say((outcome.review ? 'Held.' : 'You are in.') + cleared);
			document.getElementById('room-title')?.focus();
		} else if (opener?.isConnected) opener.focus();
		else document.getElementById('room-title')?.focus();
		opener = null;
	}

	function onkeydown(e: KeyboardEvent) {
		if (encounter || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
		// Caps Lock or Shift must not turn the shortcuts off.
		const key = e.key.toLowerCase();
		if (key === 'n' && view?.next) {
			e.preventDefault();
			next();
		} else if (key === 'f') mapRef?.focus();
		else if (key === 'm') mapRef?.fit();
		else if (e.key === 'Escape') selected = null;
	}

	const NEXT_LABEL = { review: 'Review', rematch: 'Rematch', new: 'New card' } as const;

	/** "13 due · 2 rematch · 20 new": what today holds, most urgent first. */
	function waitingLabel(c: { review: number; rematch: number; new: number }) {
		const parts = [
			c.review && `${c.review} due`,
			c.rematch && `${c.rematch} rematch`,
			c.new && `${c.new} new`
		].filter(Boolean);
		return parts.join(' · ');
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
	<main class="mx-auto flex max-w-6xl flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-row">
		<section
			aria-label="Map"
			class="relative h-[46dvh] min-h-64 border-b border-line lg:h-auto lg:flex-1 lg:border-r lg:border-b-0"
		>
			<QuestMap
				bind:this={mapRef}
				map={view.map}
				doors={doorIds}
				{selected}
				{flash}
				onselect={(n) => (selected = n && n.id !== selected ? n.id : null)}
			/>

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

			{#if picked}
				{@const d = describe(picked)}
				<div
					class="callout absolute inset-x-3 bottom-3 flex items-center gap-3 p-3"
					in:fly={{ y: still ? 0 : 8, duration: 150 }}
				>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-semibold">{picked.title}</p>
						<p class="text-xs text-muted">{d.text}</p>
					</div>
					{#if d.action}
						<button
							class="btn btn-primary min-h-11 shrink-0"
							disabled={busy}
							onclick={() => act(picked)}>{d.action}</button
						>
					{/if}
					<button
						class="btn btn-ghost min-h-11 shrink-0 px-3"
						aria-label="Close"
						onclick={() => (selected = null)}>✕</button
					>
				</div>
			{:else}
				<ul class="legend absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1">
					<li><i class="solid"></i>Known</li>
					<li><i class="fading"></i>Fading</li>
					<li><i class="lapsed"></i>Lapsed</li>
					<li><i class="door"></i>Door</li>
					<li><i class="you"></i>You</li>
				</ul>
			{/if}
		</section>

		<aside
			bind:this={panel}
			class="flex flex-col lg:w-[26rem] lg:overflow-y-auto"
			aria-label="The room you are in"
		>
			<div class="flex flex-1 flex-col gap-6 px-4 py-5">
				{#key view.room.id}
					<div in:fly={{ x: still ? 0 : 16, duration: still ? 0 : 200 }}>
						<RoomPanel room={view.room} {busy} {now} {ondoor} />
					</div>
				{/key}
				<TravelList nodes={view.map.nodes} current={view.map.current} {busy} ongo={act} />
			</div>

			<div class="sticky bottom-0 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur">
				{#if view.next}
					<button class="btn btn-primary min-h-12 w-full text-base" disabled={busy} onclick={next}>
						<span class="shrink-0">
							Next · {NEXT_LABEL[view.next.kind]}
						</span>
						<!-- Gives way first on a narrow phone: the action matters more than the tally. -->
						<span class="min-w-0 truncate font-mono text-xs opacity-75"
							>{waitingLabel(view.next.counts)}</span
						>
						<span class="kbd hidden border-transparent bg-black/15 text-current sm:inline-flex"
							>N</span
						>
					</button>
				{:else}
					<p class="py-2 text-center text-sm text-muted">
						Nothing to face right now. Everything you can reach is open or sealed.
					</p>
				{/if}
			</div>
		</aside>
	</main>
{/if}

<!-- Always in the DOM, so screen readers announce what lands in it. -->
<div class="sr-only" role="status" aria-live="polite">
	{notice?.text ?? ''}
	{view ? `You are in ${view.room.title}.` : ''}
</div>

{#if notice}
	<div
		class="toast fixed inset-x-4 bottom-24 z-30 mx-auto flex max-w-md items-center gap-3 px-4 py-3 text-sm"
		class:error={notice.tone === 'error'}
		in:fly={{ y: still ? 0 : 8, duration: 160 }}
	>
		<span class="flex-1">{notice.text}</span>
		{#if notice.login}
			<a class="btn min-h-11" href={resolve('/login')}>Log in</a>
		{/if}
		<button class="btn btn-ghost min-h-11 px-3" aria-label="Dismiss" onclick={() => (notice = null)}
			>✕</button
		>
	</div>
{/if}

{#if encounter}
	<Encounter {encounter} onrate={grade} onclose={closeEncounter} />
{/if}

<style>
	.stats {
		display: flex;
		gap: 0.5rem;
	}
	.stats > div,
	.legend,
	.callout {
		border: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface) 90%, transparent);
		backdrop-filter: blur(6px);
		border-radius: 0.75rem;
	}
	.stats > div {
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
		pointer-events: none;
		padding: 0.3rem 0.6rem;
		font-size: 12px;
		color: var(--muted);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.legend i {
		display: inline-block;
		height: 0.6rem;
		width: 0.6rem;
		border-radius: 9999px;
	}
	.legend .solid {
		background: var(--good);
	}
	.legend .fading {
		background: color-mix(in srgb, var(--hard) 78%, var(--fg));
	}
	.legend .lapsed {
		border: 1.5px solid var(--again);
	}
	.legend .door {
		border: 1.5px solid var(--accent);
		background: var(--surface);
	}
	.legend .you {
		border: 2px solid var(--accent);
		height: 0.8rem;
		width: 0.8rem;
	}
	.callout {
		box-shadow: 0 8px 30px -12px rgb(0 0 0 / 0.35);
	}
	.toast {
		border: 1px solid var(--line);
		background: var(--surface);
		border-radius: 0.9rem;
		box-shadow: 0 12px 40px -12px rgb(0 0 0 / 0.45);
	}
	.toast.error {
		border-color: color-mix(in srgb, var(--again) 50%, var(--line));
		background: color-mix(in srgb, var(--again) 10%, var(--surface));
	}
</style>
