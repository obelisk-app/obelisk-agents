#!/usr/bin/env node
// este-sech — Obelisk bot scaffold.
// Identity:  ESTE_SECH_NSEC  (or BOT_NSEC if you only run one bot)
// Pubkey:    62b95e1c2df0b2e32f1234f33f5c11e61b831a2d04488d4b2837ab962e4f54ad
// npub:      npub1v2u4u8pd7zewxtcjxnen7hq3ucdcxx3dq3yg6jegx74evtj02jksa9xjtg
//
// Configure in .env.local, then run:
//   npm run pm2:start    (registers via ecosystem.config.js)
// or for one-off testing:
//   node --env-file-if-exists=.env.local bots/este-sech.mjs

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';

const { sk, pk, npub } = identityFromEnv(process.env.ESTE_SECH_NSEC ? 'ESTE_SECH_NSEC' : 'BOT_NSEC');
const RELAYS = (process.env.ESTE_SECH_RELAYS || process.env.BOT_RELAYS || 'wss://relay.obelisk.ar')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROUPS = parseGroupList(process.env.ESTE_SECH_GROUPS || process.env.BOT_GROUPS);

const pool = createPool(sk);

console.log(`[este-sech] running as ${npub}`);
console.log(`[este-sech] relays:  ${RELAYS.join(', ')}`);
console.log(`[este-sech] groups:  ${GROUPS.map(g => `${g.relay}|${g.groupId}`).join(', ') || '(none)'}`);

// Example: subscribe to chat in each configured group and react.
for (const { relay, groupId } of GROUPS) {
  pool.subscribe(
    [relay],
    { kinds: [9], '#h': [groupId], since: Math.floor(Date.now() / 1000) },
    {
      onauth: async () => null,
      onevent: async (ev) => {
        if (ev.pubkey === pk) return;
        // TODO: react. For example, echo back any '!ping':
        if (ev.content.trim() === '!ping') {
          const reply = finalizeEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['h', groupId], ['e', ev.id], ['p', ev.pubkey]],
            content: 'pong',
          }, sk);
          try { await Promise.any(pool.publish([relay], reply)); } catch {}
        }
      },
    },
  );
}

// Keep the process alive through relay disconnects (PM2 would otherwise
// see a clean exit and restart-loop us).
setInterval(() => {}, 60_000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
