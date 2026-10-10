/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
import { files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `assets-${version}`;
const OFFLINE = '/offline.html';
// Only what the offline page needs: itself and the fonts. It runs no app JS, so the
// build output stays with the HTTP cache, which already holds it as immutable. Pages
// and API responses are never cached: they belong to one user and go stale.
const ASSETS = new Set([...files.filter((f) => f.startsWith('/fonts/')), OFFLINE]);

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...ASSETS])));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.mode === 'navigate') {
		// Without this, a home-screen launch offline lands on Safari's error page, which a
		// standalone app has no browser controls to leave. Any method: log out and delete
		// deck are plain POST forms.
		event.respondWith(
			fetch(request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error())
		);
	} else if (
		request.method === 'GET' &&
		url.origin === sw.location.origin &&
		ASSETS.has(url.pathname)
	) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(request)));
	}
});
