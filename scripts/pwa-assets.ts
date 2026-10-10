// Render the home-screen icons and iOS launch screens into static/. Rerun after a logo
// or palette change, or a new screen in src/lib/pwa/splash.ts. Usage: yarn pwa:assets
import { mkdir, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { splashScreens } from '../src/lib/pwa/splash.ts';

// The favicon's palette (static/favicon.svg): purple on light, lime on dark.
const PALETTE = {
	light: { bg: '#f6f5f1', tile: '#5b3df5', bar: '#ffffff', fg: '#17161a' },
	dark: { bg: '#0c0b10', tile: '#b4ff39', bar: '#0c0b10', fg: '#efedf6' }
};

// Logo.svelte's mark. rx 0 for icons: iOS and Android cut their own corners.
const mark = (tile: string, bar: string, rx: number) => `
<svg viewBox="0 0 32 32" width="100%" height="100%">
	<rect width="32" height="32" rx="${rx}" fill="${tile}" />
	<rect x="7" y="9" width="4" height="15" rx="1.5" fill="${bar}" />
	<rect x="14" y="17" width="4" height="7" rx="1.5" fill="${bar}" />
	<rect x="14" y="9" width="4" height="6" rx="1.5" fill="${bar}" opacity="0.45" />
	<rect x="21" y="9" width="4" height="15" rx="1.5" fill="${bar}" />
</svg>`;

const font = (await readFile('static/fonts/space-grotesk-latin.woff2')).toString('base64');

const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
});

async function render(
	path: string,
	html: string,
	{ width, height, ratio }: { width: number; height: number; ratio: number }
) {
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: ratio });
	await page.setContent(`<!doctype html><style>
		@font-face { font-family: 'Space Grotesk'; font-weight: 300 700;
			src: url(data:font/woff2;base64,${font}) format('woff2'); }
		html, body { margin: 0; height: 100%; }
	</style>${html}`);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path });
	await page.close();
}

// The bars sit inside the maskable safe zone (a circle of 40% of the width), so one
// full-bleed image serves iOS, Android's maskable icon and the plain one.
const icon = mark(PALETTE.light.tile, PALETTE.light.bar, 0);
for (const [file, size] of [
	['apple-touch-icon.png', 180],
	['icon-192.png', 192],
	['icon-512.png', 512]
] as const) {
	await render(`static/${file}`, icon, { width: size, height: size, ratio: 1 });
}

// Logo.svelte's lockup at 64pt: a 28px mark, an 8px gap and 16px type, scaled.
await rm('static/splash', { recursive: true, force: true });
await mkdir('static/splash');
for (const s of splashScreens) {
	const c = PALETTE[s.scheme];
	await render(
		`static${s.href}`,
		`<div style="display: flex; height: 100%; align-items: center; justify-content: center;
			gap: 18px; background: ${c.bg}; color: ${c.fg}; font: 600 37px 'Space Grotesk';
			letter-spacing: -0.025em">
			<div style="width: 64px; height: 64px">${mark(c.tile, c.bar, 8)}</div>Remediate
		</div>`,
		s
	);
}

await browser.close();
console.log(`Wrote 3 icons and ${splashScreens.length} launch screens`);
