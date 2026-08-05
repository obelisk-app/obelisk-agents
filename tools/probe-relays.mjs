import { SimplePool, finalizeEvent } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';
import { parseSecret } from '../lib/secret.mjs';
useWebSocketImplementation(WebSocket);

const sk = parseSecret(process.env.ZAP_BOT_NSEC);
const pool = new SimplePool({
  automaticallyAuth: () => async (evt) => finalizeEvent(evt, sk),
});

const RELAYS = [
  'wss://public.obelisk.ar',
  'wss://public.obelisk.ar',
  'wss://lacrypta-relay.obelisk.ar',
];

for (const r of RELAYS) {
  console.log(`\n=== ${r} ===`);
  const groups = new Map();
  await new Promise((resolve) => {
    let eosed = false;
    const sub = pool.subscribe([r], { kinds: [39000] }, {
      onauth: async (relay, challenge) => {
        console.log(`  AUTH challenge from ${relay}`);
        return null;
      },
      onevent: (ev) => {
        const tag = (k) => ev.tags.find((t) => t[0] === k)?.[1];
        const id = tag('d');
        if (!id) return;
        const prev = groups.get(id);
        if (prev && prev.created_at >= ev.created_at) return;
        groups.set(id, {
          name: tag('name') || '(unnamed)',
          isOpen: !!ev.tags.find((t) => t[0] === 'open'),
          isPublic: !!ev.tags.find((t) => t[0] === 'public'),
          isPrivate: !!ev.tags.find((t) => t[0] === 'private'),
          created_at: ev.created_at,
        });
      },
      oneose: () => { eosed = true; resolve(); },
      onclose: (reasons) => { console.log('  closed:', reasons); resolve(); },
    });
    setTimeout(resolve, 8000);
  });
  console.log(`  ${groups.size} group(s):`);
  for (const [id, g] of groups) {
    const flags = [g.isOpen?'open':'closed', g.isPublic?'public':(g.isPrivate?'private':'?')].join('/');
    console.log(`    ${id}  [${flags}]  ${g.name}`);
  }
}
process.exit(0);
