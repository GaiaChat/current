import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/server/vitest.config.ts',
  'packages/*/vitest.config.ts',
  'tests/vitest.config.ts'
]);
