// Try to publish a sequence of event kinds from the bot's pubkey to a
// relay, reporting accept/reject per kind. Reveals whether the relay
// has a per-kind allow-list.
import { finalizeEvent } from 'nostr-tools';
import { parseSecret } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const relay = process.argv[2];
const groupId = process.argv[3];
if (!relay || !groupId) {
  console.error('usage: probe-write.mjs <relay> <groupId>');
  process.exit(1);
}
const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const probes = [
  { kind: 1,   content: 'probe note',       tags: [] },
  { kind: 9,   content: 'probe chat',       tags: [['h', groupId]] },
  { kind: 7,   content: '⚡',                tags: [['h', groupId], ['e', 'a'.repeat(64)], ['p', 'b'.repeat(64)]] },
  { kind: 9735, content: '',                tags: [['h', groupId], ['p', 'b'.repeat(64)], ['amount', '1000'], ['bolt11', 'lnbc1n1simulated'], ['description', '{}']] },
];

for (const p of probes) {
  const ev = finalizeEvent({
    kind: p.kind, created_at: Math.floor(Date.now() / 1000), tags: p.tags, content: p.content,
  }, sk);
  const results = await Promise.allSettled(pool.publish([relay], ev));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`  kind ${p.kind}: ✓ accepted`);
    } else {
      console.log(`  kind ${p.kind}: ✗ ${r.reason?.message || r.reason}`);
    }
  }
}
setTimeout(() => process.exit(0), 1000);
