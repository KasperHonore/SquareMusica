import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Pin the zone so local-time stats (FR-030, SC-013) behave the same on every
    // host. Europe/Copenhagen observes DST, so both offsets get exercised.
    env: { TZ: 'Europe/Copenhagen' }
  }
});
