#!/usr/bin/env node
// One-shot: ask configured relays to delete the price bot's previous kind 9
// hello messages. Reads BOT_NSEC + BOT_GROUPS from .env.local, fetches every
// kind 9 the bot ever published whose content starts with the hello prefix,
// and publishes a kind 5 (NIP-09 deletion request) tagging each one.
//
// Usage:
//   npm run price-bot:cleanup
//
// Relay support is patchy — some honor kind 5 immediately, others ignore it
// and rely on clients to filter. Repeat-runs are safe (idempotent).

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';

const HELLO_PREFIX = '⚡ price bot online';
const TIMEOUT_MS = 8000;

const { sk, pk } = identityFromEnv('BOT_NSEC');
const groups = parseGroupList(process.env.BOT_GROUPS);
if (groups.length === 0) {
  console.error('BOT_GROUPS empty');
  process.exit(1);
}

const pool = createPool(sk);
let totalDeleted = 0;

await Promise.all(groups.map(({ relay, groupId }) => new Promise((resolve) => {
  const targets = [];
  const sub = pool.subscribe(
    [relay],
    { kinds: [9], authors: [pk], '#h': [groupId] },
    {
      onauth: async () => null,
      onevent: (ev) => { if (ev.content.startsWith(HELLO_PREFIX)) targets.push(ev); },
      oneose: async () => {
        sub.close();
        if (targets.length === 0) {
          console.log(`[cleanup] ${relay} ${groupId.slice(0,8)} — no hellos found`);
          return resolve();
        }
        const tags = targets.map((ev) => ['e', ev.id]);
        tags.push(['k', '9']);
        const del = finalizeEvent(
          { kind: 5, created_at: Math.floor(Date.now() / 1000), tags, content: 'remove duplicate startup hellos' },
          sk,
        );
        try {
          await Promise.any(pool.publish([relay], del));
          totalDeleted += targets.length;
          console.log(`[cleanup] ${relay} ${groupId.slice(0,8)} — kind 5 published for ${targets.length} hello(s)`);
        } catch (err) {
          console.warn(`[cleanup] ${relay} kind 5 publish failed:`, err?.message || err);
        }
        resolve();
      },
    },
  );
  setTimeout(() => { sub.close(); resolve(); }, TIMEOUT_MS);
})));

console.log(`[cleanup] done. requested deletion of ${totalDeleted} event(s).`);
process.exit(0);
