#!/usr/bin/env node
// List all NIP-29 groups visible on a relay.
//
// Usage:
//   npm run list-groups                                       # default relay
//   npm run list-groups -- wss://public.obelisk.ar            # explicit relay
//   npm run list-groups -- wss://public.obelisk.ar "chat"     # filter by name (case-insensitive substring)
//
// Subscribes to kind 39000 (group metadata), waits for EOSE, prints
// `id  [open|closed/public|private]  name — about`.

import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

const RELAY = process.argv[2] || 'wss://relay.obelisk.ar';
const FILTER = (process.argv[3] || '').toLowerCase();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 8000;

const pool = new SimplePool();
const groups = new Map();

function parseMetadata(ev) {
  const groupId = ev.tags.find((t) => t[0] === 'd')?.[1];
  if (!groupId) return;
  const prev = groups.get(groupId);
  if (prev && prev.created_at >= ev.created_at) return;
  const tag = (k) => ev.tags.find((t) => t[0] === k)?.[1];
  groups.set(groupId, {
    name: tag('name') || '',
    about: tag('about') || '',
    isOpen: !!ev.tags.find((t) => t[0] === 'open'),
    isPublic: !!ev.tags.find((t) => t[0] === 'public'),
    created_at: ev.created_at,
  });
}

console.log(`[list-groups] querying ${RELAY} (timeout ${TIMEOUT_MS}ms)…`);

pool.subscribe(
  [RELAY],
  { kinds: [39000] },
  {
    onevent: parseMetadata,
    oneose: () => { print(); process.exit(0); },
  },
);

setTimeout(() => { print(); process.exit(0); }, TIMEOUT_MS);

function print() {
  const rows = [...groups.entries()]
    .filter(([, g]) =>
      !FILTER || g.name.toLowerCase().includes(FILTER) || g.about.toLowerCase().includes(FILTER),
    )
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  if (rows.length === 0) {
    console.log(`[list-groups] no groups matched on ${RELAY}.`);
    return;
  }
  console.log(`[list-groups] ${rows.length} group(s) on ${RELAY}:\n`);
  for (const [id, g] of rows) {
    const flags = [g.isOpen ? 'open' : 'closed', g.isPublic ? 'public' : 'private'].join('/');
    const about = g.about ? ` — ${g.about.slice(0, 80)}${g.about.length > 80 ? '…' : ''}` : '';
    console.log(`  ${id}  [${flags}]  ${g.name || '(unnamed)'}${about}`);
  }
}
