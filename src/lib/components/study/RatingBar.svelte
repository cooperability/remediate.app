<script lang="ts">
	import { RATINGS } from './ratings';

	let {
		flipped,
		busy,
		hints,
		onflip,
		onrate
	}: {
		flipped: boolean;
		busy: boolean;
		/** Interval each rating would schedule, Again to Easy. */
		hints?: string[];
		onflip: () => void;
		onrate: (rating: number) => void;
	} = $props();
</script>

{#if !flipped}
	<button class="btn btn-primary w-full py-4 text-base" onclick={onflip}>
		Show answer <span class="kbd border-transparent bg-black/15 text-current">Space</span>
	</button>
{:else}
	<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
		{#each RATINGS as r (r.value)}
			<button
				class="flex items-center justify-between gap-2 rounded-xl border px-4 py-4 text-base font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 {r.class}"
				disabled={busy}
				onclick={() => onrate(r.value)}
			>
				<span class="flex flex-col items-start leading-tight">
					{r.label}
					{#if hints?.[r.value - 1]}
						<span class="font-mono text-xs font-normal opacity-80">{hints[r.value - 1]}</span>
					{/if}
				</span>
				<span class="kbd">{r.key}</span>
			</button>
		{/each}
	</div>
{/if}
