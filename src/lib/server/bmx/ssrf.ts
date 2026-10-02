import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

// SSRF guard (TDD §7.4). The harvest fetches URLs strangers wrote, so a link must
// not reach the function's own network: loopback, private ranges, link-local
// (where cloud metadata lives), or anything else that is not the public internet.
//
// The check runs inside the socket's DNS lookup, on the address the socket then
// connects to. Checking a hostname, or resolving once and connecting later, can be
// beaten by a record that points at private space or changes between the two
// (DNS rebinding). Every redirect hop goes through the same lookup.

const blocked = new BlockList();
for (const [net, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10], // carrier-grade NAT
	['127.0.0.0', 8],
	['169.254.0.0', 16], // link-local: 169.254.169.254 is cloud metadata
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4] // reserved, and 255.255.255.255
] as const)
	blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
	['::', 96], // unspecified, loopback, and IPv4-compatible (::127.0.0.1)
	['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
	['64:ff9b::', 96], // NAT64 maps onto IPv4, private space included
	['100::', 64],
	['2001:db8::', 32],
	['fc00::', 7], // unique local
	['fe80::', 10], // link-local
	['ff00::', 8] // multicast
] as const)
	blocked.addSubnet(net, bits, 'ipv6');

/** Whether an IP address is on the public internet. IPv4-mapped IPv6 is checked as IPv4. */
export function isPublicAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 0) return false;
	return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'BlockedError';
	}
}

type AddressCheck = (ip: string) => boolean;

/** A socket lookup that refuses the connection unless every resolved address passes. */
function guardedLookup(allow: AddressCheck): LookupFunction {
	return (hostname, options, callback) => {
		dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return callback(err, '', 0);
			const list = addresses as LookupAddress[];
			// One private answer among public ones is still a way in: refuse them all.
			const bad = list.find((a) => !allow(a.address));
			if (bad || list.length === 0) {
				return callback(new BlockedError(`${hostname} resolves to a non-public address`), '', 0);
			}
			if (options.all) return callback(null, list as unknown as string, 0);
			callback(null, list[0].address, list[0].family);
		});
	};
}

export interface FetchOptions {
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	/** Test seam: which addresses may be reached. Defaults to the public internet. */
	allowAddress?: AddressCheck;
	/** Test seam: reach a port other than 80 and 443. */
	allowPort?: boolean;
}

export interface FetchResult {
	/** The URL of the response, after redirects. */
	url: string;
	status: number;
	contentType: string;
	body: string;
	/** True when the body hit maxBytes and was cut. */
	truncated: boolean;
}

export const USER_AGENT = 'RemediateBot/0.1 (+https://www.remediate.app; bookmark harvester)';

const PORTS = new Set(['', '80', '443']);

function checkUrl(url: URL, allow: AddressCheck, anyPort: boolean) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new BlockedError(`scheme ${url.protocol} is not fetched`);
	}
	if (url.username || url.password) throw new BlockedError('credentials in the URL');
	// Other ports on a public host are how an attacker reaches admin panels and
	// internal services exposed by mistake. Web pages live on 80 and 443.
	if (!anyPort && !PORTS.has(url.port)) throw new BlockedError(`port ${url.port} is not fetched`);
	// A literal IP skips DNS, so the lookup guard never sees it.
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (isIP(host) && !allow(host)) throw new BlockedError(`${host} is not a public address`);
}

function decode(res: http.IncomingMessage): Readable {
	switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
		case 'gzip':
		case 'x-gzip':
			return res.pipe(createGunzip());
		case 'deflate':
			return res.pipe(createInflate());
		case 'br':
			return res.pipe(createBrotliDecompress());
		default:
			return res;
	}
}

function once(
	url: URL,
	opts: Required<Omit<FetchOptions, 'maxRedirects' | 'allowPort'>>,
	signal: AbortSignal
): Promise<{ res: http.IncomingMessage; body?: Buffer; truncated?: boolean }> {
	return new Promise((resolve, reject) => {
		const lib = url.protocol === 'https:' ? https : http;
		const req = lib.request(
			url,
			{
				method: 'GET',
				signal,
				lookup: guardedLookup(opts.allowAddress),
				headers: {
					'user-agent': USER_AGENT,
					accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
					'accept-encoding': 'gzip, deflate, br',
					'accept-language': 'en;q=1, *;q=0.5'
				}
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume();
					return resolve({ res });
				}
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				const stream = decode(res);
				stream.on('data', (c: Buffer) => {
					if (truncated) return;
					size += c.length;
					if (size > opts.maxBytes) {
						chunks.push(c.subarray(0, c.length - (size - opts.maxBytes)));
						truncated = true;
						req.destroy();
						return resolve({ res, body: Buffer.concat(chunks), truncated });
					}
					chunks.push(c);
				});
				stream.on('end', () => resolve({ res, body: Buffer.concat(chunks), truncated }));
				stream.on('error', (e) => (truncated ? undefined : reject(e)));
			}
		);
		req.on('error', reject);
		req.end();
	});
}

/**
 * The body's character set: the Content-Type header's, else a `<meta charset>`
 * in the first 1 KB (the HTML sniffing window), else UTF-8.
 */
function charsetOf(contentType: string, body: Buffer): string {
	const m =
		/charset=["']?([\w-]+)/i.exec(contentType) ??
		/<meta[^>]{0,200}?charset=["']?([\w-]+)/i.exec(body.subarray(0, 1024).toString('latin1'));
	const label = m?.[1]?.toLowerCase() ?? 'utf-8';
	try {
		new TextDecoder(label);
		return label;
	} catch {
		return 'utf-8';
	}
}

/**
 * GET a public web page. Refuses non-http(s) schemes, ports other than 80 and 443,
 * credentials, and any hop whose host resolves to a non-public address. Follows
 * at most `maxRedirects` redirects, each checked the same way. The body is cut at
 * `maxBytes` (after decompression), and the whole call at `timeoutMs`.
 */
export async function safeFetch(input: string, options: FetchOptions = {}): Promise<FetchResult> {
	const opts = {
		timeoutMs: options.timeoutMs ?? 10_000,
		maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
		allowAddress: options.allowAddress ?? isPublicAddress
	};
	const maxRedirects = options.maxRedirects ?? 3;
	const signal = AbortSignal.timeout(opts.timeoutMs);

	let url = new URL(input);
	for (let hop = 0; ; hop++) {
		checkUrl(url, opts.allowAddress, options.allowPort ?? false);
		const { res, body, truncated } = await once(url, opts, signal);
		const status = res.statusCode ?? 0;
		if (body === undefined) {
			if (hop >= maxRedirects) throw new BlockedError(`more than ${maxRedirects} redirects`);
			url = new URL(res.headers.location!, url);
			continue;
		}
		const contentType = String(res.headers['content-type'] ?? '');
		return {
			url: url.toString(),
			status,
			contentType,
			body: new TextDecoder(charsetOf(contentType, body)).decode(body),
			truncated: truncated ?? false
		};
	}
}
