/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `assets-${version}`;
const OFFLINE = '/offline.html';
// Hashed build output and fonts never change under one name. Pages and API responses
// are never cached: they belong to one user and go stale. Launch screens stay out too:
// a device only ever shows one of them.
const ASSETS = new Set([...build, ...files.filter((f) => f.startsWith('/fonts/')), OFFLINE]);

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
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin === sw.location.origin && ASSETS.has(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(request)));
	} else if (request.mode === 'navigate') {
		// Without this, a home-screen launch offline lands on Safari's error page, which a
		// standalone app has no browser controls to leave.
		event.respondWith(
			fetch(request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error())
		);
	}
});
