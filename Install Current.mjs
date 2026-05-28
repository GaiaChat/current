#!/usr/bin/env node
import { runCurrentScript } from './current-script-wrapper.mjs';

await runCurrentScript({
  script: 'install-local-current.mjs',
  pause: 'always',
  successMessage: 'Current setup is complete. You can now run Run Current.mjs.',
  failurePrefix: 'Current setup stopped with',
});
