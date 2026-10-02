import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		// Test files sign in through session rows they write. Each needs its own address:
		// user.email is unique and files run in parallel.
		env: { ALLOWED_EMAILS: 'e2e@test.invalid,e2e-error@test.invalid,e2e-harvest@test.invalid' }
	},
	use: {
		baseURL: 'http://localhost:4173',
		// A preinstalled Chromium whose build differs from this Playwright version.
		launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined }
	},
	testDir: 'e2e'
});
