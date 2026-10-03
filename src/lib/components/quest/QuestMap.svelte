<script lang="ts">
	import { untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { band } from '$lib/quest/format';
	import type { MapNode, MapView } from '$lib/quest/types';

	let {
		map,
		doors,
		selected = null,
		flash = null,
		onselect
	}: {
		map: MapView;
		/** Ids behind a door from the current room: highlighted as where you can go next. */
		doors: Set<string>;
		/** The node a first tap picked; the page shows what it is and how to go there. */
		selected?: string | null;
		/** A node that just opened: it plays a short burst. */
		flash?: string | null;
		onselect: (node: MapNode | null) => void;
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

	/** Everything on the map in view, with room at the edges for labels. */
	export function fit() {
		const b = map.bounds;
		const aspect = width && height ? height / width : 1;
		const w = Math.max(b.maxX - b.minX + PAD * 2, (b.maxY - b.minY + PAD * 2) / aspect, MIN_W * 2);
		// Labels are drawn in screen pixels: leave ~12% so edge labels are not cut off.
		frame((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, w * 1.12);
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

	// Pointers: one drags, two pinch. A press that barely moves is a tap.
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

	/**
	 * The node a tap at screen point p means: the nearest one within reach, by
	 * distance to its edge. Hit circles in the DOM overlap and stack by paint
	 * order, which sent taps to a big concept drawn over a small card.
	 */
	function nearest(p: { x: number; y: number }): MapNode | null {
		const REACH = 24;
		let best: MapNode | null = null;
		let bestD = Infinity;
		for (const n of map.nodes) {
			const sx = (n.x - vb.x) * scale;
			const sy = (n.y - vb.y) * scale;
			const r = (n.facet === 'card' ? cardR : conceptR(n)) * scale;
			const d = Math.max(0, Math.hypot(sx - p.x, sy - p.y) - r);
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
		return bestD <= REACH ? best : null;
	}

	function onpointerup(e: PointerEvent) {
		const wasTap = !dragged && pointers.size === 1;
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (wasTap) onselect(nearest(local(e)));
	}

	function oncancel(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = null;
	}

	// Sizes are in screen pixels, converted to world units, so dots stay legible
	// zoomed out and do not balloon zoomed in.
	const px = (n: number) => n / scale;
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const cardR = $derived(px(clamp(5 * scale, 2.6, 7)));
	const conceptR = (n: MapNode) => px(clamp((7 + Math.sqrt(n.weight ?? 1) * 1.4) * scale, 5, 22));
	const ring = (r: number, frac: number) => {
		const c = 2 * Math.PI * r;
		return `${c * frac} ${c}`;
	};

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

	const inView = (n: MapNode) =>
		n.x > vb.x - 40 / scale &&
		n.x < vb.x + vb.w + 40 / scale &&
		n.y > vb.y - 40 / scale &&
		n.y < vb.y + vb.h + 40 / scale;

	type Label = { id: string; x: number; y: number; text: string; size: number; tone: string };

	/**
	 * The labels to draw, placed greedily in screen space: the current room and
	 * the selected node first, then halls, concepts by size, and (zoomed in) the
	 * cards behind this room's doors. A label that would overlap one already
	 * placed, or leave the viewport, is dropped; zoom in and more fit.
	 */
	const labels = $derived.by((): Label[] => {
		const placed: [number, number, number, number][] = [];
		const out: Label[] = [];
		const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
		const tryPlace = (n: MapNode, must: boolean, size: number, tone: string) => {
			const isCard = n.facet === 'card';
			const text = cut(n.title, isCard ? 40 : 48);
			const w = text.length * size * 0.56 + 6;
			const r = (isCard ? cardR : conceptR(n)) * scale;
			// Cards label above their dot, concepts below. Slide in from the edges.
			const sx = clamp((n.x - vb.x) * scale, w / 2 + 4, width - w / 2 - 4);
			const sy = (n.y - vb.y) * scale + (isCard ? -r - 8 : r + size + 3);
			const box: [number, number, number, number] = [sx - w / 2, sy - size, sx + w / 2, sy + 3];
			if (box[1] < 0 || box[3] > height) return;
			const hit = placed.some(
				(b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]
			);
			if (hit && !must) return;
			placed.push(box);
			out.push({ id: n.id, x: vb.x + sx / scale, y: vb.y + sy / scale, text, size, tone });
		};
		if (current) tryPlace(current, true, current.facet === 'deck' ? 13 : 12, 'here');
		const sel = selected ? byId.get(selected) : undefined;
		if (sel && sel !== current) tryPlace(sel, true, 12, 'here');
		const concepts = map.nodes
			.filter((n) => n.facet !== 'card' && !n.ghost && n !== current && n !== sel && inView(n))
			.sort(
				(a, b) =>
					Number(b.facet === 'deck') - Number(a.facet === 'deck') ||
					(b.weight ?? 0) - (a.weight ?? 0)
			);
		for (const n of concepts) {
			if (n.facet !== 'deck' && scale < 0.12) continue;
			tryPlace(n, false, n.facet === 'deck' ? 13 : 11, n.facet === 'deck' ? 'hall' : '');
		}
		if (scale > 0.8) {
			for (const n of map.nodes) {
				if (n.facet === 'card' && doors.has(n.id) && n !== sel && inView(n))
					tryPlace(n, false, 10, 'door');
			}
		}
		return out;
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
			.conceptsTotal} decks and tags found. The room panel lists every door and every place you can travel to."
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
					class="node card band-{band(n.strength)}"
					class:lapsed={!n.open && !n.ghost}
					class:ghost={n.ghost}
					class:door={doors.has(n.id)}
				>
					<title>{n.title}</title>
					<circle cx={n.x} cy={n.y} r={n.ghost ? cardR * 0.8 : cardR} class="dot" />
				</g>
			{:else}
				{@const r = conceptR(n)}
				<g class="node concept {n.facet}" class:door={doors.has(n.id)}>
					<title>{n.title}</title>
					<circle cx={n.x} cy={n.y} {r} class="body" vector-effect="non-scaling-stroke" />
					{#if n.strength}
						<circle
							cx={n.x}
							cy={n.y}
							{r}
							class="progress"
							class:cleared={n.strength >= 0.8}
							stroke-width={px(3)}
							stroke-dasharray={ring(r, n.strength)}
							transform="rotate(-90 {n.x} {n.y})"
						/>
					{/if}
				</g>
			{/if}
		{/each}

		{#each labels as l (l.id)}
			<text x={l.x} y={l.y} font-size={px(l.size)} class="label {l.tone}">{l.text}</text>
		{/each}

		{#if selected && byId.get(selected)}
			{@const s = byId.get(selected)!}
			{@const r = s.facet === 'card' ? cardR : conceptR(s)}
			<circle cx={s.x} cy={s.y} r={r + px(7)} class="picked" vector-effect="non-scaling-stroke" />
		{/if}

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
		{/if}

		{#if flash && byId.get(flash) && !still}
			{@const f = byId.get(flash)!}
			{#key flash}
				<circle cx={f.x} cy={f.y} r={px(10)} class="burst" vector-effect="non-scaling-stroke" />
				<circle
					cx={f.x}
					cy={f.y}
					r={px(10)}
					class="burst late"
					vector-effect="non-scaling-stroke"
				/>
			{/key}
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
	/* Recall strength now, fading to solid. Mixed toward the foreground so each
	   step keeps 3:1 against the background in both themes. */
	.card .dot {
		fill: var(--muted);
		transition: fill 0.4s;
	}
	.card.band-1 .dot {
		fill: color-mix(in srgb, var(--hard) 78%, var(--fg));
	}
	.card.band-2 .dot {
		fill: color-mix(in srgb, var(--good) 45%, color-mix(in srgb, var(--hard) 78%, var(--fg)));
	}
	.card.band-3 .dot {
		fill: color-mix(in srgb, var(--good) 80%, var(--fg));
	}
	.card.band-4 .dot {
		fill: var(--good);
	}
	.card.lapsed .dot {
		fill: var(--bg);
		stroke: var(--again);
		stroke-width: 1.5px;
	}
	.card.ghost .dot {
		fill: none;
		stroke: var(--muted);
		stroke-width: 1px;
		stroke-dasharray: 2 2;
	}
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
	.concept.door .body {
		stroke: var(--accent);
	}
	/* Drawn in world units (stroke-width from the script): a dash pattern under
	   non-scaling-stroke is measured in screen space, and the arc comes out wrong. */
	.concept .progress {
		fill: none;
		stroke: var(--good);
	}
	.concept .progress.cleared {
		stroke: color-mix(in srgb, var(--hard) 70%, var(--good));
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
	.label.hall,
	.label.here {
		fill: var(--fg);
		font-weight: 600;
	}
	.label.door {
		fill: var(--fg);
	}
	.you,
	.picked {
		fill: none;
		stroke-width: 2.5;
		pointer-events: none;
	}
	.you {
		stroke: var(--accent);
	}
	.picked {
		stroke: var(--fg);
		stroke-dasharray: 3 3;
	}
	.pulse,
	.burst {
		transform-box: fill-box;
		transform-origin: center;
		pointer-events: none;
	}
	.pulse {
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
	.burst {
		fill: none;
		stroke: var(--good);
		stroke-width: 3;
		opacity: 0;
		animation: burst 1.1s cubic-bezier(0.2, 0.8, 0.2, 1) 1 both;
	}
	.burst.late {
		animation-delay: 0.25s;
	}
	@keyframes burst {
		from {
			opacity: 1;
			transform: scale(0.6);
		}
		to {
			opacity: 0;
			transform: scale(5);
		}
	}
</style>
