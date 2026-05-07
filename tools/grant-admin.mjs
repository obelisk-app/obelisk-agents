#!/usr/bin/env node
// Add a pubkey to a NIP-29 group as admin (or any role) by publishing
// kind 9000 from a *human admin's* nsec.
//
// You must already be an admin of the target group on the target relay —
// the relay enforces this when it processes kind 9000.
//
// Usage:
//   ADMIN_NSEC=nsec1...                              \
//   TARGET_GROUP="wss://relay.obelisk.ar|<groupId>"  \
//   TARGET_PUBKEY=<bot npub or hex>                  \
//   TARGET_ROLES=admin                               \
//     npm run grant-admin
//
// Multiple roles: TARGET_ROLES=admin,welcomer
// Default roles : admin
//
// To remove instead of add, run tools/grant-admin.mjs --remove which
// emits kind 9001 (remove-user) instead.

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv, parsePubkey } from '../lib/secret.mjs';
import { createPool, parseGroupTarget } from '../lib/pool.mjs';

const REMOVE = process.argv.includes('--remove');

const { sk: adminSk, pk: adminPk, npub: adminNpub } = identityFromEnv('ADMIN_NSEC');
const { relay, groupId } = parseGroupTarget(process.env.TARGET_GROUP);
const targetPk = parsePubkey(process.env.TARGET_PUBKEY);
const roles = (process.env.TARGET_ROLES || 'admin')
  .split(',').map((s) => s.trim()).filter(Boolean);

const pool = createPool(adminSk);

const tags = [
  ['h', groupId],
  REMOVE ? ['p', targetPk] : ['p', targetPk, ...roles],
];

const ev = finalizeEvent({
  kind: REMOVE ? 9001 : 9000,
  created_at: Math.floor(Date.now() / 1000),
  tags,
  content: REMOVE ? 'remove user' : `grant ${roles.join(',')}`,
}, adminSk);

console.log(`[${REMOVE ? 'remove' : 'grant'}] admin:    ${adminNpub} (${adminPk.slice(0,8)}…)`);
console.log(`[${REMOVE ? 'remove' : 'grant'}] target:   ${targetPk}`);
console.log(`[${REMOVE ? 'remove' : 'grant'}] group:    ${relay} ${groupId.slice(0,12)}…`);
console.log(`[${REMOVE ? 'remove' : 'grant'}] roles:    ${REMOVE ? '(none — removing)' : roles.join(',')}`);

try {
  await Promise.any(pool.publish([relay], ev));
  console.log(`[${REMOVE ? 'remove' : 'grant'}] kind ${ev.kind} published. id=${ev.id}`);
} catch (err) {
  console.error(`[${REMOVE ? 'remove' : 'grant'}] publish failed:`, err?.message || err);
  process.exit(2);
}
process.exit(0);
