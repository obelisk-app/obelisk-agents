// Query each relay for the latest kind 0 of a pubkey and print it.
import { parseSecret, parsePubkey } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';
import { nip19 } from 'nostr-tools';

const target = process.argv[2] || 'npub1xap90rsw0e2654jj5q5pvqc9xtn7hvrq9wqnk808pjvy8adax70s37amtj';
const pk = parsePubkey(target);
const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const RELAYS = [
  'wss://public.obelisk.ar',
  'wss://public.obelisk.ar',
  'wss://lacrypta-relay.obelisk.ar',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplepag.es',
];

console.log(`Looking up kind 0 for ${nip19.npubEncode(pk)}\n`);
for (const relay of RELAYS) {
  let latest = null;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
    const sub = pool.subscribe([relay], { kinds: [0], authors: [pk] }, {
      onauth: async () => null,
      onevent: (ev) => { if (!latest || ev.created_at > latest.created_at) latest = ev; },
      oneose: finish,
      onclose: finish,
    });
    setTimeout(finish, 3000);
  });
  if (!latest) {
    console.log(`${relay}: (no kind 0 found)`);
    continue;
  }
  let parsed;
  try { parsed = JSON.parse(latest.content); } catch { parsed = { content: latest.content }; }
  const ts = new Date(latest.created_at * 1000).toISOString();
  console.log(`${relay}:  ts=${ts}  picture=${parsed.picture || '∅'}`);
}
process.exit(0);
