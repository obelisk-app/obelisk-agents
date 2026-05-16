// Dump full structure of recent events in a group to see what zap-related
// kinds Obelisk actually emits.
//
// Usage:
//   node --env-file-if-exists=.env.local tools/inspect-events.mjs <relay> <groupId> [hours]
import { parseSecret } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const relay = process.argv[2];
const groupId = process.argv[3];
const HOURS = Number(process.argv[4] || 72);
if (!relay || !groupId) {
  console.error('usage: inspect-events.mjs <relay> <groupId> [hours]');
  process.exit(1);
}

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);
const SINCE = Math.floor(Date.now() / 1000) - HOURS * 3600;

const events = [];
await new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
  const sub = pool.subscribe(
    [relay],
    { '#h': [groupId], since: SINCE, limit: 200 },
    {
      onauth: async () => null,
      onevent: (ev) => events.push(ev),
      oneose: finish,
      onclose: finish,
    },
  );
  setTimeout(finish, 8000);
});

const byKind = new Map();
for (const ev of events) {
  const arr = byKind.get(ev.kind) || [];
  arr.push(ev);
  byKind.set(ev.kind, arr);
}

console.log(`\n${events.length} event(s) on ${relay} #h=${groupId} (last ${HOURS}h)`);
console.log('Breakdown by kind:');
for (const [k, arr] of [...byKind].sort((a, b) => a[0] - b[0])) {
  console.log(`  kind ${k}: ${arr.length}`);
}

// Print a sample of each non-kind-9 event (kind 9 is chat — verbose)
for (const [k, arr] of [...byKind].sort((a, b) => a[0] - b[0])) {
  if (k === 9) continue;
  console.log(`\n--- sample kind ${k} ---`);
  const sample = arr[0];
  console.log(JSON.stringify({
    id: sample.id,
    pubkey: sample.pubkey,
    created_at: new Date(sample.created_at * 1000).toISOString(),
    kind: sample.kind,
    tags: sample.tags,
    content: sample.content.length > 200 ? sample.content.slice(0, 200) + '…' : sample.content,
  }, null, 2));
}

process.exit(0);
