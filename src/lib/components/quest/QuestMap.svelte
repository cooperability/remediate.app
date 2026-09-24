<script lang="ts">
	import { untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { band } from '$lib/quest/format';
	import type { MapNode, MapView } from '$lib/quest/types';

	let {
		map,
		doors,
		onselect
	}: {
		map: MapView;
		/** Ids behind a door from the current room: highlighted as where you can go next. */
		doors: Set<string>;
		onselect: (node: MapNode) => void;
	} = $props();

	// The viewBox is the camera. It keeps the container's aspect ratio, so one
	// screen pixel is `vb.w / width` world units on both axes.
	let width = $state(0);
	let height = $state(0);
	let vb = $state({ x: -500, y: -500, w: 1000, h: 1000 });
	let fitted = $state(false);
	let svg: SVGSVGElement | undefined = $state();

	const scale = $derived(width ? width / vb.w : 1); // screen px per world unit
	const still = $derived(prefersReducedMotion.current);
	const byId = $derived(new Map(map.nodes.map((n) => [n.id, n])));
	const current = $derived(byId.get(map.current));

	const PAD = 60;
	const MIN_W = 120;

	function frame(cx: number, cy: number, w: number) {
		const aspect = width && height ? height / width : 1;
		const maxW = Math.max(
			MIN_W * 4,
			(map.bounds.maxX - map.bounds.minX + PAD * 2) * 3,
			(map.bounds.maxY - map.bounds.minY + PAD * 2) * 3
		);
		const cw = Math.min(Math.max(w, MIN_W), maxW);
		vb = { x: cx - cw / 2, y: cy - (cw * aspect) / 2, w: cw, h: cw * aspect };
	}

	/** Everything on the map in view. */
	export function fit() {
		const b = map.bounds;
		const aspect = width && height ? height / width : 1;
		const w = Math.max(b.maxX - b.minX + PAD * 2, (b.maxY - b.minY + PAD * 2) / aspect, MIN_W * 2);
		frame((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, w);
	}

	/** Close in on where the player stands. */
	export function focus() {
		if (current) frame(current.x, current.y, Math.min(vb.w, 520));
	}

	// Frame the map once the container has a size; keep the aspect as it resizes.
	// Only the size is tracked: the camera is read untracked, or every pan would re-run this.
	$effect(() => {
		if (!width || !height) return;
		untrack(() => {
			if (!fitted) {
				fitted = true;
				fit();
				return;
			}
			const cy = vb.y + vb.h / 2;
			const h = (vb.w * height) / width;
			if (Math.abs(h - vb.h) > 0.5) vb = { x: vb.x, y: cy - h / 2, w: vb.w, h };
		});
	});

	// Follow the player: when a move lands off screen, pan to it. Tracks the
	// current node only, so panning away by hand is left alone.
	$effect(() => {
		const c = current;
		if (!c) return;
		untrack(() => {
			if (!fitted) return;
			const margin = vb.w * 0.08;
			const inside =
				c.x > vb.x + margin &&
				c.x < vb.x + vb.w - margin &&
				c.y > vb.y + margin &&
				c.y < vb.y + vb.h - margin;
			if (!inside) frame(c.x, c.y, vb.w);
		});
	});

	/** Zoom by `factor` keeping the world point under screen point (sx, sy) fixed. */
	function zoomAt(sx: number, sy: number, factor: number) {
		const wx = vb.x + sx / scale;
		const wy = vb.y + sy / scale;
		const w = vb.w * factor;
		const h = w * (height / width);
		frame(wx - (sx / width) * w + w / 2, wy - (sy / height) * h + h / 2, w);
	}

	// Wheel zoom needs preventDefault, which a passive listener cannot do.
	$effect(() => {
		if (!svg) return;
		const el = svg;
		const onwheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(e.deltaY * 0.0015));
		};
		el.addEventListener('wheel', onwheel, { passive: false });
		return () => el.removeEventListener('wheel', onwheel);
	});

	// Pointers: one drags, two pinch. A press that barely moves is a tap on a node.
	// Bookkeeping, not state: nothing renders from it.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const pointers = new Map<number, { x: number; y: number }>();
	let dragged = false;
	let pinch: { d: number } | null = null;
	let start = { x: 0, y: 0 };

	function local(e: PointerEvent) {
		const r = svg!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function onpointerdown(e: PointerEvent) {
		pointers.set(e.pointerId, local(e));
		if (pointers.size === 1) {
			dragged = false;
			start = local(e);
		}
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
			dragged = true;
		}
	}

	function onpointermove(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		const p = local(e);
		if (!dragged && Math.hypot(p.x - start.x, p.y - start.y) > 6) {
			dragged = true;
			svg!.setPointerCapture(e.pointerId);
		}
		pointers.set(e.pointerId, p);
		if (pinch && pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (d > 0 && pinch.d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.d / d);
			pinch.d = d;
			return;
		}
		if (dragged && pointers.size === 1) {
			vb = { ...vb, x: vb.x - (p.x - prev.x) / scale, y: vb.y - (p.y - prev.y) / scale };
		}
	}

	function onpointerup(e: PointerEvent) {
		const wasTap = !dragged && pointers.size === 1;
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (!wasTap) return;
		const hit = (e.target as Element | null)?.closest('[data-node]');
		const node = hit && byId.get(hit.getAttribute('data-node')!);
		if (node) onselect(node);
	}

	function oncancel(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = null;
	}

	// Sizes are in screen pixels, converted to world units, so dots stay legible
	// zoomed out and do not balloon zoomed in.
	const px = (n: number) => n / scale;
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const cardR = $derived(px(clamp(5 * scale, 2.4, 7)));
	const conceptR = (n: MapNode) => px(clamp((7 + Math.sqrt(n.weight ?? 1) * 1.4) * scale, 5, 22));
	const ring = (r: number, frac: number) => {
		const c = 2 * Math.PI * r;
		return `${c * frac} ${c}`;
	};

	const inView = (n: MapNode) =>
		n.x > vb.x - 40 / scale &&
		n.x < vb.x + vb.w + 40 / scale &&
		n.y > vb.y - 40 / scale &&
		n.y < vb.y + vb.h + 40 / scale;

	/**
	 * Which concepts get a label. Greedy placement in screen space: the current
	 * room and the halls always, then tags biggest first, skipping any whose label
	 * would overlap one already placed. Zoom in and more fit.
	 */
	const labelled = $derived.by(() => {
		const placed: [number, number, number, number][] = [];
		// Built fresh on every derive and never mutated after: not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const out = new Set<string>();
		const overlaps = (box: [number, number, number, number]) =>
			placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
		// The current card's own label (drawn above its dot) claims its space first.
		const here = byId.get(map.current);
		if (here?.facet === 'card') {
			const w = Math.min(here.title.length, 42) * 11 * 0.56 + 6;
			const sx = (here.x - vb.x) * scale;
			const sy = (here.y - vb.y) * scale - cardR * scale - 10;
			placed.push([sx - w / 2, sy - 11, sx + w / 2, sy + 3]);
		}
		const candidates = map.nodes
			.filter((n) => n.facet !== 'card' && inView(n))
			.sort(
				(a, b) =>
					Number(b.id === map.current) - Number(a.id === map.current) ||
					Number(b.facet === 'deck') - Number(a.facet === 'deck') ||
					(b.weight ?? 0) - (a.weight ?? 0)
			);
		for (const n of candidates) {
			// The room you are in is always named; a hall yields only to that.
			const must = n.id === map.current || (n.facet === 'deck' && here?.facet !== 'card');
			if (!must && n.facet !== 'deck' && scale < 0.12) continue;
			const font = n.facet === 'deck' ? 13 : 11;
			const w = n.title.length * font * 0.56 + 6;
			const sx = (n.x - vb.x) * scale;
			const sy = (n.y - vb.y) * scale + conceptR(n) * scale + 13;
			const box: [number, number, number, number] = [sx - w / 2, sy - font, sx + w / 2, sy + 3];
			if (!must && overlaps(box)) continue;
			placed.push(box);
			out.add(n.id);
		}
		return out;
	});

	const edgePath = $derived.by(() => {
		let d = '';
		let near = '';
		for (const [a, b] of map.edges) {
			const p = map.nodes[a];
			const q = map.nodes[b];
			const seg = `M${p.x} ${p.y}L${q.x} ${q.y}`;
			if (p.id === map.current || q.id === map.current) near += seg;
			else d += seg;
		}
		return { d, near };
	});
</script>

<div class="relative h-full w-full" bind:clientWidth={width} bind:clientHeight={height}>
	<svg
		bind:this={svg}
		class="map h-full w-full select-none"
		viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
		role="img"
		aria-label="Map of what you know: {map.stats.cardsKnown} of {map.stats.cardsTotal} cards, {map
			.stats.conceptsFound} of {map.stats
			.conceptsTotal} decks and tags found. The room panel lists every door."
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		onpointercancel={oncancel}
	>
		<path d={edgePath.d} class="edge" vector-effect="non-scaling-stroke" />
		<path d={edgePath.near} class="edge near" vector-effect="non-scaling-stroke" />

		{#each map.nodes as n (n.id)}
			{#if n.facet === 'card'}
				<g
					data-node={n.id}
					class="node card band-{band(n.strength)}"
					class:lapsed={!n.open}
					class:door={doors.has(n.id)}
					class:here={n.id === map.current}
				>
					<title>{n.title}</title>
					<circle cx={n.x} cy={n.y} r={cardR * 2.2} class="hit" />
					<circle cx={n.x} cy={n.y} r={cardR} class="dot" />
				</g>
			{:else}
				{@const r = conceptR(n)}
				<g
					data-node={n.id}
					class="node concept {n.facet}"
					class:door={doors.has(n.id)}
					class:here={n.id === map.current}
				>
					<title>{n.title}</title>
					<circle cx={n.x} cy={n.y} r={Math.max(r * 1.4, px(22))} class="hit" />
					<circle cx={n.x} cy={n.y} {r} class="body" vector-effect="non-scaling-stroke" />
					{#if n.strength}
						<circle
							cx={n.x}
							cy={n.y}
							{r}
							class="progress"
							stroke-width={px(3)}
							stroke-dasharray={ring(r, n.strength)}
							transform="rotate(-90 {n.x} {n.y})"
						/>
					{/if}
					{#if labelled.has(n.id)}
						<text
							x={n.x}
							y={n.y + r + px(13)}
							font-size={px(n.facet === 'deck' ? 13 : 11)}
							class="label"
							class:hall={n.facet === 'deck'}>{n.title}</text
						>
					{/if}
				</g>
			{/if}
		{/each}

		{#if current}
			{@const r = current.facet === 'card' ? cardR : conceptR(current)}
			<circle
				cx={current.x}
				cy={current.y}
				r={r + px(5)}
				class="you"
				vector-effect="non-scaling-stroke"
			/>
			{#if !still}
				<circle
					cx={current.x}
					cy={current.y}
					r={r + px(5)}
					class="you pulse"
					vector-effect="non-scaling-stroke"
				/>
			{/if}
			{#if current.facet === 'card'}
				<text x={current.x} y={current.y - r - px(10)} font-size={px(11)} class="label here-label"
					>{current.title.length > 42 ? current.title.slice(0, 40) + '…' : current.title}</text
				>
			{/if}
		{/if}
	</svg>
</div>

<style>
	.map {
		touch-action: none;
		cursor: grab;
	}
	.map:active {
		cursor: grabbing;
	}
	.edge {
		fill: none;
		stroke: var(--line);
		stroke-width: 1;
		stroke-linecap: round;
	}
	.edge.near {
		stroke: var(--accent);
		stroke-opacity: 0.55;
		stroke-width: 1.5;
	}
	.node {
		cursor: pointer;
	}
	.hit {
		fill: transparent;
	}
	.card .dot {
		fill: var(--muted);
		transition: fill 0.4s;
	}
	/* Recall strength now: fading to solid. */
	.card.band-1 .dot {
		fill: var(--hard);
	}
	.card.band-2 .dot {
		fill: var(--good);
		fill-opacity: 0.5;
	}
	.card.band-3 .dot {
		fill: var(--good);
		fill-opacity: 0.78;
	}
	.card.band-4 .dot {
		fill: var(--good);
	}
	.card.lapsed .dot {
		fill: var(--bg);
		stroke: var(--again);
		stroke-width: 1.5px;
	}
	.card:hover .dot,
	.card.door .dot {
		stroke: var(--accent);
		stroke-width: 1.5px;
	}
	.concept .body {
		fill: var(--surface);
		stroke: var(--muted);
		stroke-width: 1.5;
	}
	.concept.deck .body {
		fill: var(--surface-2);
		stroke: var(--fg);
		stroke-width: 2;
	}
	.concept.door .body,
	.concept:hover .body {
		stroke: var(--accent);
	}
	/* Drawn in world units (stroke-width from the script): a dash pattern under
	   non-scaling-stroke is measured in screen space, and the arc comes out wrong. */
	.concept .progress {
		fill: none;
		stroke: var(--good);
	}
	.label {
		fill: var(--muted);
		text-anchor: middle;
		font-family: var(--font-sans);
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 3px;
		stroke-linejoin: round;
		pointer-events: none;
	}
	.label.hall {
		fill: var(--fg);
		font-weight: 600;
	}
	.here-label {
		fill: var(--fg);
		font-weight: 500;
	}
	.you {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.5;
		pointer-events: none;
	}
	.pulse {
		transform-box: fill-box;
		transform-origin: center;
		animation: pulse 2.2s ease-out infinite;
	}
	@keyframes pulse {
		from {
			opacity: 0.8;
			transform: scale(1);
		}
		to {
			opacity: 0;
			transform: scale(2.4);
		}
	}
</style>
