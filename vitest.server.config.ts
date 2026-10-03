import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	plugins: [],
	resolve: {
		// Server modules import through SvelteKit aliases. Resolve them here so the
		// database tests exercise the real repo code rather than mocks of it.
		alias: {
			$lib: here('./src/lib'),
			'$app/environment': here('./src/lib/server/testing/app-environment.ts'),
			'$env/dynamic/private': here('./src/lib/server/testing/env-private.ts')
		}
	},
	test: {
		environment: 'node',
		include: [
			'src/lib/server/**/*.test.ts',
			'src/lib/cards/**/*.test.ts',
			'src/lib/quest/**/*.test.ts'
		]
	}
});
