import { toTheme } from '$lib/theme';
import { TZ_COOKIE, toTimeZone } from '$lib/timezone';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, cookies }) => ({
	user: locals.user
		? { email: locals.user.email, guest: Boolean(locals.user.guestExpiresAt) }
		: null,
	theme: toTheme(cookies.get('theme')),
	timeZone: toTimeZone(cookies.get(TZ_COOKIE))
});
