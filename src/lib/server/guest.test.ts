import { describe, expect, it } from 'vitest';
import { throttleKey } from './guest';

describe('throttleKey', () => {
	it('keys an IPv4 address as itself', () => {
		expect(throttleKey('203.0.113.7')).toBe('203.0.113.7');
		expect(throttleKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
	});

	it('keys every address in one IPv6 /64 the same', () => {
		const key = throttleKey('2001:db8:abcd:12::1');
		expect(throttleKey('2001:0db8:abcd:0012:ffff:1:2:3')).toBe(key);
		expect(throttleKey('2001:DB8:ABCD:12:0:0:0:9')).toBe(key);
		expect(key).toBe('2001:db8:abcd:12::/64');
	});

	it('keys neighbouring /64s apart', () => {
		expect(throttleKey('2001:db8:abcd:13::1')).not.toBe(throttleKey('2001:db8:abcd:12::1'));
		expect(throttleKey('::1')).toBe('0:0:0:0::/64');
	});
});
