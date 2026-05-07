#!/usr/bin/env node
// Decode a Nostr secret in the env and print its public identity.
//
// Usage:
//   npm run whoami                       # uses BOT_NSEC
//   npm run whoami -- WELCOME_BOT_NSEC   # any env var name

import { identityFromEnv } from '../lib/secret.mjs';

const envName = process.argv[2] || 'BOT_NSEC';
try {
  const { pk, npub } = identityFromEnv(envName);
  console.log(`env:   ${envName}`);
  console.log(`hex:   ${pk}`);
  console.log(`npub:  ${npub}`);
} catch (err) {
  console.error(`whoami(${envName}) failed: ${err.message}`);
  process.exit(1);
}
