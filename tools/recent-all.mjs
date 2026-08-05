// Dump every event (any kind) from every group on the obelisk relays
// in the last N minutes — used to find what kind the Obelisk client
// publishes when a user clicks "zap".
import { parseSecret } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const MIN = Number(process.argv[2] || 30);
const SINCE = Math.floor(Date.now() / 1000) - MIN * 60;

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

const RELAYS = [
  'wss://public.obelisk.ar',
  'wss://public.obelisk.ar',
  'wss://lacrypta-relay.obelisk.ar',
];

function tag(ev, k) { return ev.tags.find((t) => t[0] === k)?.[1]; }

for (const relay of RELAYS) {
  console.log(`\n=== ${relay} (last ${MIN}min) ===`);
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
  const byKind = new Map();
  for (const gid of groupIds) {
    const events = [];
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
      const sub = pool.subscribe([relay], { '#h': [gid], since: SINCE, limit: 100 }, {
        onauth: async () => null,
        onevent: (ev) => events.push(ev),
        oneose: finish,
        onclose: finish,
      });
      setTimeout(finish, 3000);
    });
    for (const ev of events) {
      const arr = byKind.get(ev.kind) || [];
      arr.push({ gid, ev });
      byKind.set(ev.kind, arr);
    }
  }
  for (const [k, arr] of [...byKind].sort((a, b) => a[0] - b[0])) {
    console.log(`  kind ${k}: ${arr.length}`);
    // print a sample of "interesting" kinds (not 9, 9000, 9021)
    if ([9, 9000, 9021].includes(k)) continue;
    for (const { gid, ev } of arr.slice(0, 5)) {
      const tagStr = JSON.stringify(ev.tags);
      const content = ev.content.length > 80 ? ev.content.slice(0, 80) + '…' : ev.content;
      console.log(`    gid=${gid.slice(0,8)} from=${ev.pubkey.slice(0,12)} content=${JSON.stringify(content)} tags=${tagStr}`);
    }
  }
}
process.exit(0);
