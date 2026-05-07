#!/usr/bin/env node
// Publish kind 0 (profile metadata) for a bot.
//
// Usage (env-driven, easiest from a coding agent):
//   PROFILE_NAME="WelcomeBot" PROFILE_DISPLAY="Welcome Bot" \
//   PROFILE_ABOUT="Greets new members" \
//   PROFILE_PICTURE="https://example.com/avatar.png" \
//     npm run set-profile
//
// Or pass JSON on stdin:
//   echo '{"name":"WelcomeBot","about":"…"}' | npm run set-profile
//
// Identity defaults to BOT_NSEC; override with --nsec-env=NAME to use
// a different env var (e.g. WELCOME_BOT_NSEC).
//
// Relays: BOT_RELAYS (comma-separated). Defaults to wss://relay.obelisk.ar
// plus a few public profile relays so the bot is globally resolvable.

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }),
);
const envName = args['nsec-env'] || 'BOT_NSEC';

let stdinBody = '';
if (!process.stdin.isTTY) {
  stdinBody = await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}
const fromStdin = stdinBody.trim() ? JSON.parse(stdinBody) : {};

const profile = {
  name:         fromStdin.name         ?? process.env.PROFILE_NAME,
  display_name: fromStdin.display_name ?? fromStdin.displayName ?? process.env.PROFILE_DISPLAY,
  about:        fromStdin.about        ?? process.env.PROFILE_ABOUT,
  picture:      fromStdin.picture      ?? process.env.PROFILE_PICTURE,
  nip05:        fromStdin.nip05        ?? process.env.PROFILE_NIP05,
  lud16:        fromStdin.lud16        ?? process.env.PROFILE_LUD16,
  website:      fromStdin.website      ?? process.env.PROFILE_WEBSITE,
};
// Strip undefined keys so we don't blank existing fields.
for (const k of Object.keys(profile)) if (profile[k] == null || profile[k] === '') delete profile[k];

if (Object.keys(profile).length === 0) {
  console.error('No profile fields supplied. Set PROFILE_NAME/PROFILE_ABOUT/etc. or pipe JSON on stdin.');
  process.exit(1);
}

const RELAYS = (process.env.BOT_RELAYS ||
  'wss://relay.obelisk.ar,wss://relay.damus.io,wss://relay.nostr.band,wss://nos.lol,wss://relay.primal.net,wss://purplepag.es')
  .split(',').map((s) => s.trim()).filter(Boolean);

const { sk, pk, npub } = identityFromEnv(envName);
const pool = createPool(sk);

const ev = finalizeEvent({
  kind: 0,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: JSON.stringify(profile),
}, sk);

console.log(`[set-profile] identity:  ${npub}`);
console.log(`[set-profile] relays:    ${RELAYS.join(', ')}`);
console.log(`[set-profile] payload:   ${JSON.stringify(profile)}`);

const results = await Promise.allSettled(pool.publish(RELAYS, ev));
const ok = results.filter((r) => r.status === 'fulfilled').length;
const failed = results.length - ok;
console.log(`[set-profile] published kind:0 to ${ok}/${results.length} relays${failed ? ` (${failed} failed)` : ''}.`);
process.exit(0);
