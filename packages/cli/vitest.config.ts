import { defineConfig } from 'vitest/config';

// Local config so `npm test -w @diagram-engine/cli` works when run from this
// directory (mirrors packages/core/vitest.config.ts). The root run picks this
// file up through its `projects: ['packages/*']` glob.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Real sockets and filesystem watchers: give the watcher tests room.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
