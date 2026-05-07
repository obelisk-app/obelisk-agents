// Identity helpers: parse a Nostr secret key from any common form,
// resolve a public-key target (hex or npub).
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

export function parseSecret(input) {
  const v = String(input ?? '').trim();
  if (v.startsWith('nsec1')) {
    const { type, data } = nip19.decode(v);
    if (type !== 'nsec') throw new Error('not an nsec');
    return data;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new Error('secret must be nsec1... or 64-char hex');
}

export function parsePubkey(input) {
  const v = String(input ?? '').trim();
  if (v.startsWith('npub1')) {
    const { type, data } = nip19.decode(v);
    if (type !== 'npub') throw new Error('not an npub');
    return data;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  throw new Error('pubkey must be npub1... or 64-char hex');
}

export function identityFromEnv(envName = 'BOT_NSEC') {
  if (!process.env[envName]) throw new Error(`${envName} not set in environment`);
  const sk = parseSecret(process.env[envName]);
  const pk = getPublicKey(sk);
  return { sk, pk, npub: nip19.npubEncode(pk) };
}

export function newIdentity() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return {
    sk,
    pk,
    npub: nip19.npubEncode(pk),
    nsec: nip19.nsecEncode(sk),
  };
}
