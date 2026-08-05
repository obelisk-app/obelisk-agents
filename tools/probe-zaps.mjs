// Probe kind 9735 (zap receipts) on the configured relays:
//   1. Per-group historical lookback with `#h` (what the bot subscribes to).
//   2. Same lookback WITHOUT `#h` — catches receipts whose author skipped
//      the h-tag (their zap request inside `description` may still carry it).
//
// Usage:
//   node --env-file-if-exists=.env.local tools/probe-zaps.mjs [hours]
import { finalizeEvent } from 'nostr-tools';
import { parseSecret } from '../lib/secret.mjs';
import { createPool } from '../lib/pool.mjs';

const HOURS = Number(process.argv[2] || 24);
const SINCE = Math.floor(Date.now() / 1000) - HOURS * 3600;
const RELAYS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['wss://public.obelisk.ar', 'wss://public.obelisk.ar', 'wss://lacrypta-relay.obelisk.ar'];

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = createPool(sk);

function tag(ev, k) { return ev.tags.find((t) => t[0] === k)?.[1]; }

async function queryRelay(relay, filter, label) {
  const events = [];
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
    const sub = pool.subscribe([relay], filter, {
      onauth: async () => null,
      onevent: (ev) => events.push(ev),
      oneose: finish,
      onclose: finish,
    });
    setTimeout(finish, 6000);
  });
  console.log(`  ${label}: ${events.length} event(s)`);
  for (const ev of events.slice(0, 3)) {
    const desc = tag(ev, 'description');
    let zapReq = null;
    try { zapReq = desc ? JSON.parse(desc) : null; } catch {}
    const receiptH = tag(ev, 'h');
    const reqH = zapReq && zapReq.tags?.find?.((t) => t[0] === 'h')?.[1];
    const amount = tag(ev, 'amount') || zapReq?.tags?.find?.((t) => t[0] === 'amount')?.[1];
    console.log(`    id=${ev.id.slice(0,12)} at=${new Date(ev.created_at*1000).toISOString()} receiptH=${receiptH || '∅'} reqH=${reqH || '∅'} amount=${amount || '?'}`);
  }
  return events;
}

for (const relay of RELAYS) {
  console.log(`\n=== ${relay} (last ${HOURS}h) ===`);
  await queryRelay(relay, { kinds: [9735], since: SINCE, limit: 200 }, 'kind 9735 receipts (no #h)');
  await queryRelay(relay, { kinds: [9734], since: SINCE, limit: 200 }, 'kind 9734 zap requests (no #h)');
  await queryRelay(relay, { kinds: [7], since: SINCE, limit: 30 }, 'kind 7 reactions (no #h)');

  // Discover groups, then sample with #h filter for first 5
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
  console.log(`  ${groupIds.length} group(s) discovered`);
  for (const gid of groupIds.slice(0, 5)) {
    await queryRelay(relay, { kinds: [9735], '#h': [gid], since: SINCE, limit: 50 }, `  kind 9735 #h=${gid.slice(0,8)}`);
  }
}

process.exit(0);
