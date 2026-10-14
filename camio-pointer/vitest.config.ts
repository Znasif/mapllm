import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts', 'dist/*.test.ts'],
		exclude: ['**/node_modules/**'],
		// The shipped smoke test runs in jsdom, as in Audiom's own Vitest setup.
		environmentMatchGlobs: [['dist/**', 'jsdom']],
		setupFiles: ['test/setup.ts'],
		// The image tests are long and CPU-bound: separate processes, and not
		// more of them than cores, so the worker RPC is never starved.
		pool: 'forks',
		maxWorkers: 4,
		minWorkers: 1,
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
