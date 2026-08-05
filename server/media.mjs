// Media uploads for bot profiles, Blossom-style (BUD-02): the server signs
// a kind 24242 authorization with the BOT's own key and PUTs the bytes to a
// public Blossom host, so the stored blob is attributable to the bot
// identity. First server that accepts wins.
import crypto from 'node:crypto';
import { finalizeEvent } from 'nostr-tools';

const DEFAULT_SERVERS = [
  'https://blossom.primal.net',
  'https://blossom.band',
  'https://nostr.download',
];

export async function uploadToBlossom(sk, buffer, mime) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const servers = (process.env.MANAGER_BLOSSOM_SERVERS ?? DEFAULT_SERVERS.join(','))
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['x', sha256],
      ['expiration', String(now + 300)],
    ],
    content: 'upload',
  }, sk);
  const header = `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`;

  const errors = [];
  for (const server of servers) {
    try {
      const res = await fetch(`${server}/upload`, {
        method: 'PUT',
        headers: { Authorization: header, 'Content-Type': mime },
        body: buffer,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        errors.push(`${server} → ${res.status}`);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      return { url: body.url ?? `${server}/${sha256}`, sha256, server };
    } catch (err) {
      errors.push(`${server} → ${err.message}`);
    }
  }
  throw new Error(`upload failed on every Blossom server: ${errors.join('; ')}`);
}
