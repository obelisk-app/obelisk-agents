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
// Relays: BOT_RELAYS (comma-separated). Defaults to wss://public.obelisk.ar
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
  'wss://public.obelisk.ar,wss://relay.damus.io,wss://relay.nostr.band,wss://nos.lol,wss://relay.primal.net,wss://purplepag.es')
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

// Warm each connection so NIP-42 AUTH completes before we publish — some
// relays drop the first event on a fresh connection if AUTH is still in
// flight, which then masquerades as a generic rejection.
await new Promise((resolve) => {
  const sub = pool.subscribe(RELAYS, { kinds: [0], authors: [pk], limit: 1 }, {
    onauth: async () => null,
    oneose: () => { try { sub.close(); } catch {} resolve(); },
    onclose: () => resolve(),
  });
  setTimeout(resolve, 2500);
});

async function publishWithReport() {
  const results = await Promise.allSettled(pool.publish(RELAYS, ev));
  return results.map((r, i) => ({
    relay: RELAYS[i],
    ok: r.status === 'fulfilled',
    reason: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null,
  }));
}

let report = await publishWithReport();
// Retry the rejected ones once after a short delay (auth-race recovery).
const retries = report.filter((r) => !r.ok).map((r) => r.relay);
if (retries.length) {
  await new Promise((res) => setTimeout(res, 1500));
  const second = await Promise.allSettled(pool.publish(retries, ev));
  for (let i = 0; i < retries.length; i++) {
    const idx = report.findIndex((r) => r.relay === retries[i]);
    if (second[i].status === 'fulfilled') report[idx] = { relay: retries[i], ok: true, reason: null };
    else report[idx].reason = second[i].reason?.message || String(second[i].reason);
  }
}

for (const r of report) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.relay}${r.ok ? '' : ` — ${r.reason}`}`);
}
const ok = report.filter((r) => r.ok).length;
console.log(`[set-profile] ${ok}/${report.length} relays accepted kind:0.`);
process.exit(0);
