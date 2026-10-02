import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedError, isPublicAddress, safeFetch } from './ssrf';

describe('isPublicAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'255.255.255.255',
		'224.0.0.1',
		'::1',
		'::',
		'fe80::1',
		'fd00::1',
		'::ffff:127.0.0.1',
		'::ffff:169.254.169.254',
		'64:ff9b::a9fe:a9fe',
		'64:ff9b:1::a9fe:a9fe',
		'::127.0.0.1',
		'::a9fe:a9fe',
		'not an ip'
	])('blocks %s', (ip) => {
		expect(isPublicAddress(ip)).toBe(false);
	});

	it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
		'allows %s',
		(ip) => {
			expect(isPublicAddress(ip)).toBe(true);
		}
	);
});

// A real server on loopback. The default guard must refuse it; the tests that
// need a response pass an allowAddress that admits 127.0.0.1 only.
describe('safeFetch', () => {
	let server: http.Server;
	let port = 0;
	const only127 = (ip: string) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const path = req.url ?? '/';
			if (path === '/page') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				return res.end('<title>Hi</title>');
			}
			if (path === '/gzip') {
				res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
				return res.end(gzipSync('<title>Zipped</title>'));
			}
			if (path === '/big') {
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('x'.repeat(50_000));
			}
			if (path === '/to-page') {
				res.writeHead(302, { location: '/page' });
				return res.end();
			}
			// A public-looking hop that sends the fetch to another loopback address.
			if (path === '/to-private') {
				res.writeHead(302, { location: `http://127.0.0.2:${port}/page` });
				return res.end();
			}
			if (path === '/to-metadata') {
				res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
				return res.end();
			}
			if (path === '/loop') {
				res.writeHead(302, { location: '/loop' });
				return res.end();
			}
			if (path === '/slow') return; // never answers
			// Headers and half a gzip stream, then silence: the timeout must still fire
			// while the body is being decoded.
			if (path === '/slow-gzip') {
				const zipped = gzipSync('<title>'.padEnd(5000, 'x'));
				res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
				return res.write(zipped.subarray(0, zipped.length / 2));
			}
			// No charset in the header: the page declares windows-1252 itself.
			if (path === '/cp1252') {
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end(
					Buffer.concat([
						Buffer.from('<meta charset="windows-1252"><title>'),
						Buffer.from([0x93, 0x51, 0x94]),
						Buffer.from('</title>')
					])
				);
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => {
		server.closeAllConnections();
		server.close();
	});

	// Port 80 is required by the guard, so these go through an allowAddress seam
	// and a Host on the test port. The port check is exercised separately below.
	const at = (path: string, host = '127.0.0.1') => `http://${host}:${port}${path}`;
	const fetchTest = (url: string, extra: Parameters<typeof safeFetch>[1] = {}) =>
		safeFetch(url, { allowAddress: only127, allowPort: true, ...extra });

	it('refuses loopback by default, by name and by literal IP', async () => {
		await expect(safeFetch(`http://localhost/page`)).rejects.toBeInstanceOf(BlockedError);
		await expect(safeFetch(`http://127.0.0.1/page`)).rejects.toBeInstanceOf(BlockedError);
		await expect(safeFetch(`http://[::1]/page`)).rejects.toBeInstanceOf(BlockedError);
		await expect(safeFetch(`http://169.254.169.254/latest/meta-data/`)).rejects.toBeInstanceOf(
			BlockedError
		);
	});

	it('refuses other schemes, ports and credentials', async () => {
		await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedError);
		await expect(safeFetch('https://example.com:8443/')).rejects.toBeInstanceOf(BlockedError);
		await expect(safeFetch('https://u:p@example.com/')).rejects.toBeInstanceOf(BlockedError);
	});

	it('fetches an allowed page and decodes it', async () => {
		const res = await fetchTest(at('/page'));
		expect(res).toMatchObject({ status: 200, body: '<title>Hi</title>', truncated: false });
		expect((await fetchTest(at('/gzip'))).body).toBe('<title>Zipped</title>');
	});

	it('decodes a body in the charset its <meta> declares', async () => {
		expect((await fetchTest(at('/cp1252'))).body).toContain('<title>\u201cQ\u201d</title>');
	});

	it('follows a redirect and reports the final URL', async () => {
		const res = await fetchTest(at('/to-page'));
		expect(res.url).toBe(at('/page'));
		expect(res.body).toBe('<title>Hi</title>');
	});

	it('re-checks every redirect hop', async () => {
		await expect(fetchTest(at('/to-private'))).rejects.toBeInstanceOf(BlockedError);
		await expect(fetchTest(at('/to-metadata'))).rejects.toBeInstanceOf(BlockedError);
	});

	it('caps redirects', async () => {
		await expect(fetchTest(at('/loop'))).rejects.toThrow(/redirects/);
	});

	it('cuts the body at maxBytes', async () => {
		const res = await fetchTest(at('/big'), { maxBytes: 1000 });
		expect(res.body).toHaveLength(1000);
		expect(res.truncated).toBe(true);
	});

	it('gives up at the timeout', async () => {
		await expect(fetchTest(at('/slow'), { timeoutMs: 300 })).rejects.toMatchObject({
			name: expect.stringMatching(/TimeoutError|AbortError/)
		});
	});

	it('gives up at the timeout mid-body', async () => {
		const started = Date.now();
		await expect(fetchTest(at('/slow-gzip'), { timeoutMs: 300 })).rejects.toBeDefined();
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
