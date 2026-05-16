// Publish a synthetic NIP-57 zap receipt (kind 9735) so we can verify
// the bot picks it up and announces it. Signed by ZAP_BOT_NSEC so the
// NIP-29 relay accepts it (the bot has already been admitted there).
//
// Usage:
//   node --env-file-if-exists=.env.local tools/simulate-zap.mjs \
//     <senderNpubOrHex> <recipientNpubOrHex> <amountSats> [relay] [groupId]
import { finalizeEvent, nip19 } from 'nostr-tools';
import { parseSecret, parsePubkey } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const [, , senderArg, recipientArg, satsArg, relayArg, groupArg] = process.argv;
if (!senderArg || !recipientArg) {
  console.error('usage: simulate-zap.mjs <senderNpubOrHex> <recipientNpubOrHex> [sats] [relay] [groupId]');
  process.exit(1);
}

const senderHex = parsePubkey(senderArg);
const recipientHex = parsePubkey(recipientArg);
const sats = Number(satsArg || 420);
const relay = relayArg || 'wss://public.obelisk.ar';
const groupId = groupArg || '26a9cceda473cb1b';
const msats = sats * 1000;

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const fakeMsgId = 'ba5cbc7746c13230bbfeef233b16000aa23d498633b4dc969852b50a538b5939';
const fakePreimage = '0'.repeat(64);
const fakeBolt11 = 'lnbc' + sats + 'n1simulated';

// Embedded zap request (kind 9734), signed by the "sender".
// We don't have the sender's secret key, so we mock the structure but
// pretend it's authored by them — the bot reads sender via the explicit
// "P" tag on the receipt anyway, which is more authoritative.
const zapRequest = {
  kind: 9734,
  pubkey: senderHex,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['p', recipientHex],
    ['e', fakeMsgId],
    ['amount', String(msats)],
    ['relays', relay],
    ['h', groupId],
  ],
  content: 'simulated zap',
  id: 'simulated-' + Date.now(),
  sig: '0'.repeat(128),
};

const receipt = finalizeEvent({
  kind: 9735,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['h', groupId],
    ['p', recipientHex],
    ['P', senderHex],
    ['e', fakeMsgId],
    ['amount', String(msats)],
    ['bolt11', fakeBolt11],
    ['preimage', fakePreimage],
    ['description', JSON.stringify(zapRequest)],
  ],
  content: '',
}, sk);

console.log(`[sim] publishing kind 9735 to ${relay} h=${groupId}`);
console.log(`[sim] sender:    ${nip19.npubEncode(senderHex)}`);
console.log(`[sim] recipient: ${nip19.npubEncode(recipientHex)}`);
console.log(`[sim] amount:    ${sats} sats (${msats} msats)`);
console.log(`[sim] receipt id: ${receipt.id}`);

// Warm the connection so NIP-42 AUTH completes before we publish.
// Some relays reject the first event on a connection if AUTH hasn't
// finalised yet (first event triggers the challenge, but the publish
// is already in-flight by the time AUTH resolves).
await new Promise((resolve) => {
  const sub = pool.subscribe([relay], { kinds: [0], authors: [receipt.pubkey], limit: 1 }, {
    onauth: async () => null,
    oneose: () => { try { sub.close(); } catch {} resolve(); },
    onclose: () => resolve(),
  });
  setTimeout(resolve, 2500);
});

async function publishOnce() {
  const results = await Promise.allSettled(pool.publish([relay], receipt));
  return results[0];
}

let r = await publishOnce();
if (r.status === 'rejected') {
  console.log(`[sim] first attempt rejected (${r.reason?.message || r.reason}); retrying once after 1.5s…`);
  await new Promise((res) => setTimeout(res, 1500));
  r = await publishOnce();
}
if (r.status === 'fulfilled') console.log(`[sim] ✓ accepted: ${r.value}`);
else console.log(`[sim] ✗ rejected: ${r.reason?.message || r.reason}`);

setTimeout(() => process.exit(0), 1500);
