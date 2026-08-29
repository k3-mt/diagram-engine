import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

// M0 smoke test: proves the root `npm test` wiring runs workspace tests.
describe('workspace wiring', () => {
  it('core package placeholder exports', () => {
    expect(CORE_PACKAGE).toBe('@diagram-engine/core');
  });
});
