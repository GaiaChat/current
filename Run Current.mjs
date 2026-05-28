#!/usr/bin/env node
import { runCurrentScript } from './current-script-wrapper.mjs';

await runCurrentScript({
  script: 'start-current-server.mjs',
  banner: true,
  pause: 'error',
  failurePrefix: 'Current server stopped with',
});
