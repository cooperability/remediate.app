<script lang="ts">
	import { onMount } from 'svelte';
	import { fly, scale } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import Flashcard from '$lib/components/study/Flashcard.svelte';
	import RatingBar from '$lib/components/study/RatingBar.svelte';
	import { studyKey } from '$lib/components/study/keys';
	import { reopens } from '$lib/quest/format';
	import type { EncounterCard, Outcome } from '$lib/quest/types';

	let {
		encounter,
		onrate,
		onclose
	}: {
		encounter: EncounterCard;
		/** Grade through /api/review/grade. Resolves with the outcome, or throws. */
		onrate: (rating: number) => Promise<Outcome>;
		/** `outcome`: how it went, or null when the player left before grading. */
		onclose: (outcome: Outcome | null) => void;
	} = $props();

	let flipped = $state(false);
	let busy = $state(false);
	let outcome = $state<Outcome | null>(null);
	let failed = $state<string | null>(null);
	let dialog: HTMLDialogElement | undefined = $state();
	let body: HTMLDivElement | undefined = $state();
	let next: HTMLButtonElement | undefined = $state();
	const still = $derived(prefersReducedMotion.current);

	// A native modal dialog: the page behind it is inert to keyboard, pointer and
	// screen reader alike, and Esc arrives as a cancel event.
	onMount(() => {
		dialog?.showModal();
		// Not the first button (Later): Space would press it instead of flipping the card.
		body?.focus();
		return () => dialog?.close();
	});

	$effect(() => {
		if (outcome) next?.focus();
	});

	async function rate(r: number) {
		if (!flipped || busy || outcome) return;
		busy = true;
		failed = null;
		try {
			outcome = await onrate(r);
		} catch (e) {
			failed = String(e instanceof Error ? e.message : e);
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (outcome) return;
		const k = studyKey(e);
		if (k === 'flip') {
			e.preventDefault();
			flipped = true;
		} else if (k !== null) rate(k);
	}

	const heading = $derived(
		encounter.review ? 'A review' : encounter.fresh ? 'A new door' : 'A locked door'
	);
	const lead = $derived(
		encounter.review
			? 'You know this one, and FSRS says it is fading. Recall it to keep the door open.'
			: encounter.fresh
				? 'Meet this card to open the way. Rate honestly: the scheduler and the map both use it.'
				: 'You missed this one before. Recall it to open the door.'
	);
</script>

<dialog
	bind:this={dialog}
	class="encounter"
	aria-labelledby="encounter-title"
	oncancel={(e) => {
		e.preventDefault();
		onclose(outcome);
	}}
	{onkeydown}
>
	<div
		bind:this={body}
		tabindex="-1"
		class="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pt-4 pb-6 focus:outline-none"
	>
		<header class="flex items-center gap-3">
			<button class="btn btn-ghost -ml-2 min-h-11 px-3 text-muted" onclick={() => onclose(outcome)}>
				<span aria-hidden="true">←</span>
				{outcome ? 'Back' : 'Later'}
			</button>
			<p id="encounter-title" class="flex-1 text-center text-sm font-medium">{heading}</p>
			<span class="kbd hidden sm:inline-flex">Esc</span>
		</header>

		<p class="mt-4 text-center text-sm text-muted">{lead}</p>

		<div class="mt-5 flex flex-1 flex-col gap-6">
			{#if outcome}
				<div
					class="panel flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
					in:scale={{ start: still ? 1 : 0.96, duration: still ? 0 : 220 }}
					role="status"
				>
					{#if outcome.unlocked}
						<div class="badge open" aria-hidden="true">
							<svg viewBox="0 0 48 48"
								><rect x="11" y="21" width="26" height="19" rx="4" /><path
									d="M17 21v-5a7 7 0 0 1 13.6-2.4"
									class:swing={!still}
								/></svg
							>
						</div>
						<p class="text-2xl font-bold tracking-tight">
							{outcome.review
								? 'Held. The door stays open.'
								: encounter.fresh
									? 'The door opens.'
									: 'The door opens again.'}
						</p>
						<p class="max-w-sm text-sm text-muted">
							{outcome.review
								? 'Recalled on time: FSRS pushes the next review further out.'
								: encounter.fresh
									? 'A new room. Its tags are on your map, and the recall counts in Cards too.'
									: 'Back on your map. The recall counts in Cards too.'}
						</p>
						{#if outcome.cleared?.length}
							<p class="cleared" in:fly={{ y: still ? 0 : 8, duration: 300, delay: 200 }}>
								<span class="eyebrow">Cleared</span>
								{outcome.cleared.join(', ')}
								<span class="text-muted">: 80% known</span>
							</p>
						{/if}
						<button
							class="btn btn-primary mt-2 min-h-11 px-6 text-base"
							bind:this={next}
							onclick={() => onclose(outcome)}
						>
							Step inside
						</button>
					{:else}
						<div class="badge shut" aria-hidden="true">
							<svg viewBox="0 0 48 48"
								><rect x="11" y="21" width="26" height="19" rx="4" /><path
									d="M17 21v-5a7 7 0 0 1 14 0v5"
								/></svg
							>
						</div>
						<p class="text-2xl font-bold tracking-tight">
							{outcome.review ? 'It slipped. The door closes.' : 'It stays shut, for now.'}
						</p>
						<p class="max-w-sm text-sm text-muted">
							{outcome.retryAt
								? `You can try again ${reopens(outcome.retryAt)}, when the scheduler says it is worth asking.`
								: 'Try it again later.'} Missing it is useful: it tells the scheduler what to show you.
						</p>
						<button
							class="btn mt-2 min-h-11 px-6 text-base"
							bind:this={next}
							onclick={() => onclose(outcome)}
						>
							Back to the room
						</button>
					{/if}
				</div>
			{:else}
				<div in:fly={{ y: still ? 0 : 12, duration: still ? 0 : 200 }}>
					<Flashcard card={encounter} {flipped} />
				</div>
				<div class="sticky bottom-0 -mx-4 mt-auto bg-bg/85 px-4 py-3 backdrop-blur">
					{#if failed}
						<p
							class="mb-2 rounded-xl border border-again/40 bg-again/10 px-3 py-2 text-sm"
							role="alert"
						>
							<span class="font-medium text-again">Could not save.</span>
							{failed} Rate again to retry.
						</p>
					{/if}
					<RatingBar {flipped} {busy} onflip={() => (flipped = true)} onrate={rate} />
				</div>
			{/if}
		</div>
	</div>
</dialog>

<style>
	.encounter {
		margin: 0;
		height: 100dvh;
		max-height: none;
		width: 100vw;
		max-width: none;
		border: 0;
		padding: 0;
		background: color-mix(in srgb, var(--bg) 96%, transparent);
		color: var(--fg);
		overflow-y: auto;
	}
	.encounter::backdrop {
		background: color-mix(in srgb, var(--bg) 60%, transparent);
		backdrop-filter: blur(4px);
	}
	.badge {
		display: flex;
		height: 5rem;
		width: 5rem;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
	}
	.badge.open {
		background: color-mix(in srgb, var(--good) 15%, transparent);
		color: var(--good);
	}
	.badge.shut {
		background: var(--surface-2);
		color: var(--muted);
	}
	svg {
		height: 3rem;
		width: 3rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.swing {
		transform-origin: 30px 21px;
		animation: swing 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}
	@keyframes swing {
		from {
			transform: rotate(0deg) translateY(4px);
		}
		to {
			transform: rotate(-18deg);
		}
	}
	.cleared {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: center;
		gap: 0.5rem;
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--hard) 45%, transparent);
		background: color-mix(in srgb, var(--hard) 12%, transparent);
		padding: 0.5rem 0.9rem;
		font-weight: 600;
	}
</style>
