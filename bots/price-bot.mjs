#!/usr/bin/env node
// Obelisk price bot — Nostr client that publishes BTC stats and answers
// price queries in NIP-29 groups. No backend.
//
// Capabilities:
//   1. Profile ticker — publishes kind:0 metadata (display name = "BTC $123,456")
//      to every configured relay. The bot's profile is globally resolvable.
//   2. Group chat updates — periodically posts a kind 9 price summary to each
//      configured (relay, group) pair, gated on price change.
//   3. Slash-command listener — subscribes to kind 9 in each configured group
//      and replies to "!btc", "!price", "!ath" with fresh stats.
//   4. Multi-relay AUTH — signs NIP-42 challenges with the bot nsec.
//
// Configuration (env, typically `.env.local`):
//   BOT_NSEC          required. nsec1... or 64-char hex.
//   BOT_RELAYS        comma-separated relay URLs for kind:0 broadcast.
//                     default: wss://public.obelisk.ar
//   BOT_GROUPS        comma-separated `relayUrl|groupId` pairs the bot posts
//                     chat into and listens for slash-commands on.
//                     default: <empty> (bot is profile-only)
//                     example: wss://public.obelisk.ar|dab35d8ad892da76,wss://public.obelisk.ar|deadbeef1234
//   BOT_INTERVAL_MS         default 120000 — price refresh interval.
//   BOT_CHAT_EVERY_N_TICKS  default 0 (off). If >0, publishes kind 9 summary
//                           to every configured group every N price-change ticks.
//   BOT_DISPLAY             default "BTC ${price}" — kind:0 name template.
//
// Legacy: BOT_GROUP_ID still supported — treated as a single group on the
// first BOT_RELAYS entry.

import { finalizeEvent, nip19 } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { createStateStore } from '../lib/state.mjs';

const { loadState, saveState, statePath } = createStateStore({
  fileName: 'obelisk-price-bot-state.json',
  envName: 'BOT_STATE_PATH',
  logPrefix: 'price-bot',
});

const INTERVAL = Number(process.env.BOT_INTERVAL_MS) || 120_000;
const TEMPLATE = process.env.BOT_DISPLAY || 'BTC ${price}';
const CHAT_EVERY_N = Math.max(0, Number(process.env.BOT_CHAT_EVERY_N_TICKS) || 0);

const RELAYS = (process.env.BOT_RELAYS || 'wss://public.obelisk.ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const GROUPS = (() => {
  const out = parseGroupList(process.env.BOT_GROUPS);
  if (out.length === 0 && process.env.BOT_GROUP_ID) {
    out.push({ relay: RELAYS[0], groupId: process.env.BOT_GROUP_ID.trim() });
  }
  return out;
})();

async function fetchBtcStats() {
  const url =
    'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json();
  const m = j.market_data;
  return {
    price: Math.round(m.current_price.usd),
    high24: Math.round(m.high_24h.usd),
    low24: Math.round(m.low_24h.usd),
    change24Pct: m.price_change_percentage_24h,
    ath: Math.round(m.ath.usd),
    athChangePct: m.ath_change_percentage.usd,
  };
}

const fmt = (n) => n.toLocaleString('en-US');
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function summary(s) {
  return `BTC $${fmt(s.price)} · 24h ${pct(s.change24Pct)} · range $${fmt(s.low24)}–$${fmt(s.high24)} · ATH $${fmt(s.ath)} (${pct(s.athChangePct)})`;
}

function commandReply(cmd, s) {
  switch (cmd) {
    case 'price':
    case 'btc':
      return `⚡ BTC/USD $${fmt(s.price)} (${pct(s.change24Pct)} 24h)`;
    case 'ath':
      return `🏔 ATH $${fmt(s.ath)} (${pct(s.athChangePct)} from ATH, currently $${fmt(s.price)})`;
    case 'stats':
      return summary(s);
    case 'help':
      return 'Commands: !btc, !price, !ath, !stats, !help';
    default:
      return null;
  }
}

function sigTerm() {
  console.log('[price-bot] shutting down…');
  process.exit(0);
}

async function main() {
  if (!process.env.BOT_NSEC) {
    console.log('[price-bot] BOT_NSEC not set — bot disabled.');
    return;
  }
  const { sk, pk, npub } = identityFromEnv('BOT_NSEC');

  console.log(`[price-bot] pubkey hex:  ${pk}`);
  console.log(`[price-bot] pubkey npub: ${npub}`);
  console.log(`[price-bot] relays:      ${RELAYS.join(', ')}`);
  console.log(`[price-bot] groups:      ${GROUPS.map((g) => `${g.relay}|${g.groupId}`).join(', ') || '(none)'}`);
  console.log(`[price-bot] state:       ${statePath}`);
  console.log(`[price-bot] interval:    ${INTERVAL}ms; chat every ${CHAT_EVERY_N} ticks`);

  const pool = createPool(sk);

  process.on('SIGINT', sigTerm);
  process.on('SIGTERM', sigTerm);

  // ── Slash-command listener (per group) ──────────────────────────────
  // Subscribes to kind 9 with `#h=groupId` on each group's relay and replies
  // to known commands. Uses an in-memory `seen` set so re-deliveries on
  // reconnect don't re-trigger.
  const seen = new Set();
  // relay29 (public.obelisk.ar / public.obelisk.ar) closes REQs after EOSE
  // instead of streaming live events — reconnect on every onclose.
  const subscribeListener = (relay, groupId) => {
    let since = Math.floor(Date.now() / 1000) - 5;
    let closed = false;
    const open = () => {
      if (closed) return;
      const sub = pool.subscribe(
        [relay],
        { kinds: [9], '#h': [groupId], since },
        {
          onauth: async () => null,
          oneose: () => console.log(`[price-bot] sub EOSE ${relay} ${groupId.slice(0,8)}`),
          onclose: () => {
            if (closed) return;
            since = Math.floor(Date.now() / 1000);
            setTimeout(open, 1500);
          },
          onevent: async (ev) => {
            since = Math.max(since, ev.created_at);
            if (process.env.BOT_DEBUG === '1') {
              console.log(`[price-bot] saw kind:9 from ${ev.pubkey.slice(0,8)} on ${groupId.slice(0,8)}: ${ev.content.slice(0,60)}`);
            }
            if (ev.pubkey === pk) return;
            if (seen.has(ev.id)) return;
            seen.add(ev.id);
            const m = ev.content.trim().match(/^!(\w+)/);
            if (!m) return;
            try {
              const s = await fetchBtcStats();
              const reply = commandReply(m[1].toLowerCase(), s);
              if (!reply) return;
              const ev2 = finalizeEvent(
                {
                  kind: 9,
                  created_at: Math.floor(Date.now() / 1000),
                  tags: [['h', groupId], ['e', ev.id], ['p', ev.pubkey]],
                  content: reply,
                },
                sk,
              );
              await Promise.any(pool.publish([relay], ev2));
              console.log(`[price-bot] replied !${m[1]} on ${relay} group ${groupId.slice(0, 8)}`);
            } catch (err) {
              console.warn(`[price-bot] command !${m[1]} failed:`, err?.message || err);
            }
          },
        },
      );
      return () => { closed = true; sub.close(); };
    };
    open();
  };
  for (const { relay, groupId } of GROUPS) subscribeListener(relay, groupId);

  // ── Group hello + join-request, once per (relay, groupId) ever ──────
  const state = loadState();
  state.joined ||= {};
  state.greeted ||= {};
  for (const { relay, groupId } of GROUPS) {
    const key = `${relay}|${groupId}`;
    if (!state.joined[key]) {
      const join = finalizeEvent(
        {
          kind: 9021,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['h', groupId]],
          content: 'price bot join',
        },
        sk,
      );
      try {
        await Promise.any(pool.publish([relay], join));
        console.log(`[price-bot] join-request sent: ${relay} ${groupId.slice(0, 8)}`);
        state.joined[key] = Math.floor(Date.now() / 1000);
        saveState(state);
      } catch (err) {
        console.warn(`[price-bot] join-request failed on ${relay}:`, err?.message || err);
      }
    }
    if (!state.greeted[key]) {
      const hello = finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['h', groupId]],
          content:
            '⚡ price bot online — try !btc, !price, !ath, !stats, !help.',
        },
        sk,
      );
      try {
        await Promise.any(pool.publish([relay], hello));
        console.log(`[price-bot] hello sent: ${relay} ${groupId.slice(0, 8)}`);
        state.greeted[key] = Math.floor(Date.now() / 1000);
        saveState(state);
      } catch (err) {
        console.warn(`[price-bot] hello failed on ${relay} (likely not admitted yet):`, err?.message || err);
      }
    } else {
      console.log(`[price-bot] hello already sent for ${relay} ${groupId.slice(0, 8)} — skipping`);
    }
  }

  // ── Price tick: kind:0 ticker, optional periodic kind 9 summary ─────
  let lastPrice = null;
  let priceChangeCount = 0;
  const tick = async () => {
    let s;
    try {
      s = await fetchBtcStats();
    } catch (err) {
      console.warn('[price-bot] tick fetch failed:', err?.message || err);
      return;
    }
    if (s.price === lastPrice) return;
    lastPrice = s.price;
    priceChangeCount += 1;

    const name = TEMPLATE.replace('${price}', fmt(s.price));
    const meta = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name,
          display_name: name,
          about: summary(s),
          picture:
            'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/1280px-Bitcoin.svg.png',
        }),
      },
      sk,
    );
    try {
      await Promise.any(pool.publish(RELAYS, meta));
      console.log(`[price-bot] kind:0 → ${name} (${pct(s.change24Pct)} 24h)`);
    } catch (err) {
      console.warn('[price-bot] kind:0 publish failed:', err?.message || err);
    }

    if (CHAT_EVERY_N > 0 && priceChangeCount % CHAT_EVERY_N === 0) {
      for (const { relay, groupId } of GROUPS) {
        const ev = finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['h', groupId]],
            content: summary(s),
          },
          sk,
        );
        try {
          await Promise.any(pool.publish([relay], ev));
          console.log(`[price-bot] kind:9 → ${relay} ${groupId.slice(0, 8)}`);
        } catch (err) {
          console.warn(`[price-bot] kind:9 publish failed on ${relay}:`, err?.message || err);
        }
      }
    }
  };

  await tick();
  setInterval(tick, INTERVAL);
}

main().catch((err) => {
  console.error('[price-bot] fatal:', err);
  process.exit(1);
});
