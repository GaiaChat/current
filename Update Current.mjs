#!/usr/bin/env node
import { runCurrentScript } from './current-script-wrapper.mjs';

await runCurrentScript({
  script: 'update-current-server.mjs',
  defaultArgs: ['--no-pause'],
  pause: 'always',
  successMessage: 'Current updater is complete.',
  failurePrefix: 'Current updater stopped with',
});
