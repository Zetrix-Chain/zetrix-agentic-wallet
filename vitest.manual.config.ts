import { defineConfig } from 'vitest/config'

/**
 * Manual, network-touching checks only. Kept out of `vitest.config.ts` so a node outage or a VPN
 * cannot turn an unrelated commit red — these are run deliberately, never in CI.
 */
export default defineConfig({
  test: { include: ['src/__tests__/**/*.manual.test.ts'], testTimeout: 60000 },
})
