// Find which field of a kind 9735 event triggers the lacrypta/relay
// whitelist rejection by trying variants from minimal to fully-realistic.
import { finalizeEvent } from 'nostr-tools';
import { parseSecret, parsePubkey } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const relay = process.argv[2] || 'wss://lacrypta-relay.obelisk.ar';
const groupId = process.argv[3] || 'de8bb87545bea285';
const senderHex = parsePubkey('npub1m9vsm9d8sy0pevcjhenwm4ny6l37dm2hsg4dnusna43ql3n5305qy4zlg4');
const recipientHex = parsePubkey('npub1jecfrphcxmysz5ju43e8w0kwtejxalnj5fhmegh883ylna0erdlqz66588');

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const fakeMsgId = 'a'.repeat(64);
const zapRequest = {
  kind: 9734,
  pubkey: senderHex,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['p', recipientHex], ['e', fakeMsgId], ['amount', '420000'], ['relays', relay], ['h', groupId]],
  content: '',
  id: 'simulated-' + Date.now(),
  sig: '0'.repeat(128),
};

const variants = [
  {
    label: 'minimal: h+p+amount+bolt11+description{}',
    tags: [['h', groupId], ['p', recipientHex], ['amount', '420000'], ['bolt11', 'lnbc1n1x'], ['description', '{}']],
  },
  {
    label: 'add P (sender) tag',
    tags: [['h', groupId], ['p', recipientHex], ['P', senderHex], ['amount', '420000'], ['bolt11', 'lnbc1n1x'], ['description', '{}']],
  },
  {
    label: 'add e (zapped msg) tag',
    tags: [['h', groupId], ['p', recipientHex], ['e', fakeMsgId], ['amount', '420000'], ['bolt11', 'lnbc1n1x'], ['description', '{}']],
  },
  {
    label: 'full description with sender pubkey',
    tags: [['h', groupId], ['p', recipientHex], ['amount', '420000'], ['bolt11', 'lnbc1n1x'], ['description', JSON.stringify(zapRequest)]],
  },
  {
    label: 'full description with bot as sender pubkey',
    tags: [['h', groupId], ['p', recipientHex], ['amount', '420000'], ['bolt11', 'lnbc1n1x'], ['description', JSON.stringify({ ...zapRequest, pubkey: '3742578e0e7e55aa5652a02816030532e7ebb0602b813b1de70c9843f5bd379f' })]],
  },
];

for (const v of variants) {
  const ev = finalizeEvent({ kind: 9735, created_at: Math.floor(Date.now() / 1000), tags: v.tags, content: '' }, sk);
  const results = await Promise.allSettled(pool.publish([relay], ev));
  for (const r of results) {
    if (r.status === 'fulfilled') console.log(`  ✓ ${v.label}`);
    else console.log(`  ✗ ${v.label} :: ${r.reason?.message || r.reason}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
setTimeout(() => process.exit(0), 800);
