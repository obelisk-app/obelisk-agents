#!/usr/bin/env node
// Add a pubkey to a NIP-29 group as a plain member (no admin role) by
// publishing kind 9000 from a human admin's nsec. Open groups will
// auto-admit on a kind 9021 join-request from the bot itself, but this
// tool lets an admin add a member directly.
//
// Usage:
//   ADMIN_NSEC=nsec1...                              \
//   TARGET_GROUP="wss://relay.obelisk.ar|<groupId>"  \
//   TARGET_PUBKEY=<bot npub or hex>                  \
//     npm run add-member
//
// This is a wrapper around grant-admin with TARGET_ROLES forced empty —
// kept as its own command for legibility in scripts and runbooks.

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv, parsePubkey } from '../lib/secret.mjs';
import { createPool, parseGroupTarget } from '../lib/pool.mjs';

const { sk: adminSk, npub: adminNpub } = identityFromEnv('ADMIN_NSEC');
const { relay, groupId } = parseGroupTarget(process.env.TARGET_GROUP);
const targetPk = parsePubkey(process.env.TARGET_PUBKEY);

const pool = createPool(adminSk);

const ev = finalizeEvent({
  kind: 9000,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['h', groupId], ['p', targetPk]], // no role tag → plain member
  content: 'add member',
}, adminSk);

console.log(`[add-member] admin:   ${adminNpub}`);
console.log(`[add-member] target:  ${targetPk}`);
console.log(`[add-member] group:   ${relay} ${groupId.slice(0,12)}…`);

try {
  await Promise.any(pool.publish([relay], ev));
  console.log(`[add-member] kind 9000 published. id=${ev.id}`);
} catch (err) {
  console.error(`[add-member] publish failed:`, err?.message || err);
  process.exit(2);
}
process.exit(0);
