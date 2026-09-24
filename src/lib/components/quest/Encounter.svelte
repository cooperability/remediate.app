<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
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
		/** `entered`: the door opened and the player is inside. */
		onclose: (entered: boolean) => void;
	} = $props();

	let flipped = $state(false);
	let busy = $state(false);
	let outcome = $state<Outcome | null>(null);
	let failed = $state<string | null>(null);
	let dialog: HTMLDivElement | undefined = $state();
	let next: HTMLButtonElement | undefined = $state();
	const still = $derived(prefersReducedMotion.current);

	$effect(() => {
		// Focus moves into the dialog, and to the result button once there is one.
		(outcome ? next : dialog)?.focus();
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
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose(outcome?.unlocked ?? false);
			return;
		}
		if (outcome) return;
		const k = studyKey(e);
		if (k === 'flip') {
			e.preventDefault();
			flipped = true;
		} else if (k !== null) rate(k);
	}
</script>

<svelte:window {onkeydown} />

<div
	class="fixed inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="encounter-title"
	tabindex="-1"
	bind:this={dialog}
	transition:fade={{ duration: still ? 0 : 150 }}
>
	<div class="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 pt-4 pb-6">
		<header class="flex items-center gap-3">
			<button
				class="btn btn-ghost -ml-2 px-2 py-1 text-muted"
				onclick={() => onclose(outcome?.unlocked ?? false)}
			>
				<span aria-hidden="true">←</span> Back
			</button>
			<p id="encounter-title" class="flex-1 text-center text-sm font-medium">
				{encounter.fresh ? 'A new door' : 'A locked door'}
			</p>
			<span class="kbd">Esc</span>
		</header>

		<p class="mt-4 text-center text-sm text-muted">
			{encounter.fresh
				? 'Meet this card to open the way. Rate honestly: the scheduler and the map both use it.'
				: 'This door needs a rematch. Recall it to open it again.'}
		</p>

		<div class="mt-5 flex flex-1 flex-col gap-6">
			{#if outcome}
				<div
					class="panel flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
					in:scale={{ start: still ? 1 : 0.96, duration: still ? 0 : 220 }}
					role="status"
				>
					{#if outcome.unlocked}
						<div class="unlock" aria-hidden="true">
							<svg viewBox="0 0 48 48"
								><rect x="11" y="21" width="26" height="19" rx="4" /><path
									d="M17 21v-5a7 7 0 0 1 13.6-2.4"
									class:swing={!still}
								/></svg
							>
						</div>
						<p class="text-2xl font-bold tracking-tight">The door opens.</p>
						<p class="max-w-sm text-sm text-muted">
							That recall counts in Cards too. The room and its tags are on your map now.
						</p>
						<button
							class="btn btn-primary mt-2 px-6 py-3 text-base"
							bind:this={next}
							onclick={() => onclose(true)}
						>
							Step inside
						</button>
					{:else}
						<div class="shut" aria-hidden="true">
							<svg viewBox="0 0 48 48"
								><rect x="11" y="21" width="26" height="19" rx="4" /><path
									d="M17 21v-5a7 7 0 0 1 14 0v5"
								/></svg
							>
						</div>
						<p class="text-2xl font-bold tracking-tight">It stays shut, for now.</p>
						<p class="max-w-sm text-sm text-muted">
							{outcome.retryAt
								? `You can try again ${reopens(outcome.retryAt)}, when the scheduler says it is worth asking.`
								: 'Try it again later.'} Missing it is useful: it tells the scheduler what to show you.
						</p>
						<button
							class="btn mt-2 px-6 py-3 text-base"
							bind:this={next}
							onclick={() => onclose(false)}
						>
							Back to the room
						</button>
					{/if}
				</div>
			{:else}
				<div in:fly={{ y: still ? 0 : 12, duration: still ? 0 : 200 }}>
					<Flashcard card={encounter} {flipped} />
				</div>
				{#if failed}
					<p class="panel border-again/40 bg-again/10 px-4 py-3 text-sm" role="alert">
						<span class="font-medium text-again">Could not save.</span>
						<span class="font-mono text-xs text-muted">{failed}</span> Rate again to retry.
					</p>
				{/if}
				<div class="sticky bottom-0 -mx-4 mt-auto bg-bg/85 px-4 py-3 backdrop-blur">
					<RatingBar {flipped} {busy} onflip={() => (flipped = true)} onrate={rate} />
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.unlock,
	.shut {
		display: flex;
		height: 5rem;
		width: 5rem;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
	}
	.unlock {
		background: color-mix(in srgb, var(--good) 15%, transparent);
		color: var(--good);
	}
	.shut {
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
</style>
