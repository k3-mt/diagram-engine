import { defineConfig } from 'vitest/config';

// Local config so `npm test` works when run from packages/viewer directly.
// Without this, vitest resolves the repo-root config whose
// `projects: ['packages/*']` glob matches nothing relative to this directory.
// The root run still works: its projects glob picks this config up for the
// viewer project.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts']
  }
});
