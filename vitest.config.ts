import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    /**
     * `*.manual.test.ts` files talk to the real chain and are run deliberately, via
     * `vitest.manual.config.ts`. They must never run here: `npm test` has to stay a pure unit run,
     * or a node outage or a VPN drop turns an unrelated commit red.
     *
     * Vitest's default `include` glob matches `*.manual.test.ts` too, so declaring the manual
     * config alone was NOT enough — it selected them for the manual run without deselecting them
     * here, and `npm test` was quietly making live network calls (APP-C01).
     */
    exclude: [...configDefaults.exclude, '**/*.manual.test.ts'],
  },
})
