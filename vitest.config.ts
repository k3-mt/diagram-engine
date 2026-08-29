import { defineConfig } from 'vitest/config';

// Root config: runs the test suites of every workspace package.
export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: true
  }
});
