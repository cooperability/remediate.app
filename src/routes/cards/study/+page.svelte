<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import Flashcard from '$lib/components/study/Flashcard.svelte';
	import RatingBar from '$lib/components/study/RatingBar.svelte';
	import RoundIntro from '$lib/components/study/RoundIntro.svelte';
	import RoundResults from '$lib/components/study/RoundResults.svelte';
	import { studyKey } from '$lib/components/study/keys';
	import type { Grades } from '$lib/components/study/ratings';
	import { MAX_REPEATS, resumeQueue } from '$lib/cards/round';

	let { data } = $props();

	type Card = (typeof data.cards)[number];

	let queue = $state<{ card: Card; repeats: number }[]>([]);
	let done = $state(0);
	let flipped = $state(false);
	let busy = $state(false);
	let grades = $state<Grades | null>(null);
	let failed = $state<string | null>(null);

	$effect.pre(() => {
		// A reload resumes the open round: replay what the server already logged.
		const resumed = resumeQueue(data.cards, data.progress);
		queue = resumed.queue;
		done = resumed.done;
		flipped = false;
		grades = null;
		failed = null;
		// Every card was graded but the round never closed, e.g. the finish request failed.
		// Test the local result: reading `queue` here would make this effect depend on
		// the state it just wrote, and Svelte aborts the loop.
		if (resumed.queue.length === 0) untrack(retry);
	});

	const current = $derived(queue[0]);
	const total = $derived(data.cards.length);
	const still = $derived(prefersReducedMotion.current);

	async function post(path: string, body: unknown) {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (res.status === 401) throw new Error('Your session ended. Log in again');
		if (!res.ok) throw new Error(`${path} ${res.status}`);
		return res.json();
	}

	async function finish() {
		grades = await post('/api/review/finish', { assessmentId: data.assessmentId });
	}

	async function rate(rating: number) {
		if (!current || !flipped || busy) return;
		busy = true;
		try {
			const stored: { rating: number; preview: string[] | null } = await post('/api/review/grade', {
				assessmentId: data.assessmentId,
				nodeId: current.card.id,
				rating,
				attempt: current.repeats
			});
			const [head, ...rest] = queue;
			if (head.repeats === 0) done += 1;
			queue =
				stored.rating === 1 && head.repeats < MAX_REPEATS
					? [
							...rest,
							{
								card: { ...head.card, preview: stored.preview ?? head.card.preview },
								repeats: head.repeats + 1
							}
						]
					: rest;
			flipped = false;
			if (queue.length === 0) await finish();
		} catch (e) {
			failed = String(e);
		} finally {
			busy = false;
		}
	}

	// A failed grade leaves the queue untouched, so dismissing lets the same card be
	// rated again. A failed finish has an empty queue, so it retries the finish.
	async function retry() {
		failed = null;
		if (queue.length > 0 || grades) return;
		busy = true;
		try {
			await finish();
		} catch (e) {
			failed = String(e);
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (grades || failed || !current) return;
		const k = studyKey(e);
		if (k === 'flip') {
			e.preventDefault();
			flipped = true;
		} else if (k !== null) rate(k);
	}
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>{data.deck} · Remediate</title>
</svelte:head>

<div class="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 pb-10">
	<header class="bg-bg/85 sticky top-0 z-10 -mx-4 px-4 pt-4 pb-3 backdrop-blur">
		<div class="flex items-center gap-3 text-sm">
			<a href={resolve('/cards')} class="btn btn-ghost text-muted -ml-2 px-2 py-1">
				<span aria-hidden="true">←</span> Decks
			</a>
			<span class="min-w-0 flex-1 truncate text-center font-medium">{data.deck}</span>
			{#if current && current.repeats > 0 && !grades}
				<span class="chip border-again/30 bg-again/10 text-again">relearning</span>
			{/if}
			<span class="text-muted font-mono text-xs tabular-nums">{done} / {total}</span>
		</div>
		<div
			class="bg-surface-2 mt-3 h-1.5 overflow-hidden rounded-full"
			role="progressbar"
			aria-label="Round progress"
			aria-valuemin={0}
			aria-valuemax={total}
			aria-valuenow={done}
		>
			<div
				class="bg-accent h-full rounded-full transition-[width] duration-300"
				style="width: {total ? (done / total) * 100 : 0}%"
			></div>
		</div>
	</header>

	{#if failed}
		<div
			class="panel border-again/40 bg-again/10 mt-6 flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
			role="alert"
			in:fly={{ y: still ? 0 : -8, duration: 200 }}
		>
			<span class="text-again font-medium">Could not save.</span>
			<span class="text-muted min-w-0 flex-1 truncate font-mono text-xs">{failed}</span>
			<button class="btn px-3 py-1" onclick={retry}>Retry</button>
			<button class="btn btn-ghost px-3 py-1" onclick={() => location.reload()}>Reload</button>
		</div>
	{/if}

	<main class="mt-6 flex flex-1 flex-col gap-6">
		{#if grades}
			<RoundResults
				{grades}
				priorScore={data.prior?.score ?? null}
				onnext={() => invalidate('cards:round')}
			/>
		{:else if current}
			{#if data.prior && done === 0 && current.repeats === 0}
				<RoundIntro prior={data.prior} />
			{/if}

			{#key `${current.card.id}:${current.repeats}`}
				<div in:fly={{ x: still ? 0 : 24, duration: still ? 0 : 220 }}>
					<Flashcard card={current.card} {flipped} />
				</div>
			{/key}

			<div class="bg-bg/85 sticky bottom-0 -mx-4 mt-auto px-4 py-3 backdrop-blur">
				<RatingBar
					{flipped}
					{busy}
					hints={current.card.preview}
					onflip={() => (flipped = true)}
					onrate={rate}
				/>
			</div>
		{:else if busy}
			<p class="text-muted mt-16 text-center text-sm">Scoring the round…</p>
		{/if}
	</main>
</div>
