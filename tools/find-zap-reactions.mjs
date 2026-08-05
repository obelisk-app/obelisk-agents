// Find recent kind 7 ⚡ reactions across all groups on the three relays,
// and dump their full structure so we can see how the amount is recorded.
import { parseSecret } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const HOURS = Number(process.argv[2] || 24);
const SINCE = Math.floor(Date.now() / 1000) - HOURS * 3600;

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const RELAYS = [
  'wss://public.obelisk.ar',
  'wss://public.obelisk.ar',
  'wss://lacrypta-relay.obelisk.ar',
];

function tag(ev, k) { return ev.tags.find((t) => t[0] === k)?.[1]; }

for (const relay of RELAYS) {
  console.log(`\n=== ${relay} (last ${HOURS}h) ===`);

  // Discover groups
  const metaEvents = [];
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
    const sub = pool.subscribe([relay], { kinds: [39000] }, {
      onauth: async () => null,
      onevent: (ev) => metaEvents.push(ev),
      oneose: finish,
      onclose: finish,
    });
    setTimeout(finish, 4000);
  });
  const groupIds = [...new Set(metaEvents.map((ev) => tag(ev, 'd')).filter(Boolean))];

  let total = 0;
  let zapLike = 0;
  for (const gid of groupIds) {
    const events = [];
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
      const sub = pool.subscribe([relay], { kinds: [7], '#h': [gid], since: SINCE, limit: 200 }, {
        onauth: async () => null,
        onevent: (ev) => events.push(ev),
        oneose: finish,
        onclose: finish,
      });
      setTimeout(finish, 4000);
    });
    total += events.length;
    for (const ev of events) {
      if (ev.content === '⚡' || ev.content?.includes('⚡') || ev.content === '+') {
        zapLike += 1;
        console.log(`  [${new Date(ev.created_at*1000).toISOString()}] gid=${gid.slice(0,8)} from=${ev.pubkey.slice(0,12)} content=${JSON.stringify(ev.content)}`);
        console.log(`    tags: ${JSON.stringify(ev.tags)}`);
      }
    }
  }
  console.log(`  total kind 7 = ${total}, zap-like = ${zapLike}`);
}

process.exit(0);
