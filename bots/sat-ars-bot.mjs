#!/usr/bin/env node
// Obelisk sat/ARS bot — Nostr client that publishes the satoshi-to-Argentine-peso
// price as kind:0 metadata and answers slash commands in NIP-29 groups.
//
// Capabilities (mirror price-bot):
//   1. Profile ticker — kind:0 with display name "sat 1.20 ARS" updated whenever
//      the displayed value changes (rounded to 2 decimals — ARS gets close to 1).
//   2. Group hello + slash-command listener.
//   3. Optional periodic kind 9 summary every N price-change ticks.
//   4. NIP-42 AUTH on every relay (lib/pool.mjs).
//
// Configuration — uses SAT_ARS_BOT_* env vars (gitignored .env.local), falling
// back to BOT_* shared vars only if the per-bot var is unset. Identity is
// SAT_ARS_BOT_NSEC — never share an nsec with price-bot or kind:0 fights ensue.
//
//   SAT_ARS_BOT_NSEC          required. nsec1... or 64-char hex.
//   SAT_ARS_BOT_RELAYS        comma-separated relay URLs for kind:0 broadcast.
//                             default: BOT_RELAYS or wss://relay.obelisk.ar
//   SAT_ARS_BOT_GROUPS        comma-separated `relayUrl|groupId` pairs.
//                             default: empty (profile-only)
//   SAT_ARS_BOT_INTERVAL_MS   default 60000 — yadio refreshes more often than coingecko.
//   SAT_ARS_BOT_DISPLAY       default "sat ${price} ARS" — kind:0 name template.
//                             ${price} = ARS-per-sat to 2 decimals.
//   SAT_ARS_BOT_CHAT_EVERY_N_TICKS  default 0 (off).

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { createStateStore } from '../lib/state.mjs';

const { loadState, saveState, statePath } = createStateStore({
  fileName: 'obelisk-sat-ars-bot-state.json',
  envName: 'SAT_ARS_BOT_STATE_PATH',
  logPrefix: 'sat-ars-bot',
});

const ENV_NAME = process.env.SAT_ARS_BOT_NSEC ? 'SAT_ARS_BOT_NSEC' : 'BOT_NSEC';

const INTERVAL = Number(process.env.SAT_ARS_BOT_INTERVAL_MS || process.env.BOT_INTERVAL_MS) || 60_000;
const TEMPLATE = process.env.SAT_ARS_BOT_DISPLAY || process.env.BOT_DISPLAY_SAT_ARS || 'sat ${price} ARS';
const CHAT_EVERY_N = Math.max(0, Number(process.env.SAT_ARS_BOT_CHAT_EVERY_N_TICKS) || 0);

const RELAYS = (process.env.SAT_ARS_BOT_RELAYS || process.env.BOT_RELAYS || 'wss://relay.obelisk.ar')
  .split(',').map((s) => s.trim()).filter(Boolean);

const GROUPS = parseGroupList(process.env.SAT_ARS_BOT_GROUPS || process.env.BOT_GROUPS);

// ── Yadio API ────────────────────────────────────────────────────────
// /convert/1/BTC/ARS  → { rate: <ars-per-btc>, result: <ars-per-btc>, timestamp }
// /convert/1/USD/ARS  → { rate: <ars-per-usd>, result: <ars-per-usd>, timestamp }
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`yadio ${r.status} ${url}`);
  return r.json();
}

async function fetchStats() {
  const [btcArs, usdArs] = await Promise.all([
    fetchJson('https://api.yadio.io/convert/1/BTC/ARS'),
    fetchJson('https://api.yadio.io/convert/1/USD/ARS'),
  ]);
  const arsPerBtc = Number(btcArs.rate ?? btcArs.result);
  const arsPerUsd = Number(usdArs.rate ?? usdArs.result);
  if (!Number.isFinite(arsPerBtc) || arsPerBtc <= 0) throw new Error('yadio: bad BTC/ARS rate');
  if (!Number.isFinite(arsPerUsd) || arsPerUsd <= 0) throw new Error('yadio: bad USD/ARS rate');
  const arsPerSat = arsPerBtc / 100_000_000;
  const usdPerBtc = arsPerBtc / arsPerUsd;
  return {
    arsPerSat,
    arsPerBtc,
    arsPerUsd,
    usdPerBtc,
    timestamp: btcArs.timestamp || Date.now(),
  };
}

const fmtAr2 = (n) => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAr0 = (n) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 });
const fmtUs0 = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

function summary(s) {
  return `1 sat = ${fmtAr2(s.arsPerSat)} ARS · 1k sats = ${fmtAr0(s.arsPerSat * 1000)} ARS · BTC $${fmtUs0(s.usdPerBtc)} (≈ ${fmtAr0(s.arsPerBtc / 1_000_000)}M ARS) · USD/ARS ${fmtAr0(s.arsPerUsd)}`;
}

function commandReply(cmd, s) {
  switch (cmd) {
    case 'sat':
    case 'sats':
      return `⚡ 1 sat = ${fmtAr2(s.arsPerSat)} ARS · 1k = ${fmtAr0(s.arsPerSat * 1000)} ARS · 10k = ${fmtAr0(s.arsPerSat * 10_000)} ARS`;
    case 'btc':
      return `₿ BTC $${fmtUs0(s.usdPerBtc)} USD ≈ ${fmtAr0(s.arsPerBtc / 1_000_000)}M ARS`;
    case 'ars':
    case 'usd':
    case 'usdars':
      return `💵 USD/ARS ${fmtAr0(s.arsPerUsd)} · BTC/ARS ${fmtAr0(s.arsPerBtc)}`;
    case 'stats':
      return summary(s);
    case 'help':
      return 'Commands: !sat, !sats, !btc, !ars, !stats, !help';
    default:
      return null;
  }
}

function sigTerm() {
  console.log('[sat-ars-bot] shutting down…');
  process.exit(0);
}

async function main() {
  if (!process.env[ENV_NAME]) {
    console.log(`[sat-ars-bot] ${ENV_NAME} not set — bot disabled.`);
    return;
  }
  const { sk, pk, npub } = identityFromEnv(ENV_NAME);

  console.log(`[sat-ars-bot] env:         ${ENV_NAME}`);
  console.log(`[sat-ars-bot] pubkey hex:  ${pk}`);
  console.log(`[sat-ars-bot] pubkey npub: ${npub}`);
  console.log(`[sat-ars-bot] relays:      ${RELAYS.join(', ')}`);
  console.log(`[sat-ars-bot] groups:      ${GROUPS.map((g) => `${g.relay}|${g.groupId}`).join(', ') || '(none)'}`);
  console.log(`[sat-ars-bot] state:       ${statePath}`);
  console.log(`[sat-ars-bot] interval:    ${INTERVAL}ms; chat every ${CHAT_EVERY_N} ticks`);

  const pool = createPool(sk);

  process.on('SIGINT', sigTerm);
  process.on('SIGTERM', sigTerm);

  // ── Slash-command listener (per group) ──────────────────────────────
  const seen = new Set();
  const subscribeListener = (relay, groupId) => {
    let since = Math.floor(Date.now() / 1000) - 5;
    let closed = false;
    const open = () => {
      if (closed) return;
      pool.subscribe(
        [relay],
        { kinds: [9], '#h': [groupId], since },
        {
          onauth: async () => null,
          oneose: () => console.log(`[sat-ars-bot] sub EOSE ${relay} ${groupId.slice(0, 8)}`),
          onclose: () => {
            if (closed) return;
            since = Math.floor(Date.now() / 1000);
            setTimeout(open, 1500);
          },
          onevent: async (ev) => {
            since = Math.max(since, ev.created_at);
            if (ev.pubkey === pk) return;
            if (seen.has(ev.id)) return;
            seen.add(ev.id);
            const m = ev.content.trim().match(/^!(\w+)/);
            if (!m) return;
            try {
              const s = await fetchStats();
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
              console.log(`[sat-ars-bot] replied !${m[1]} on ${relay} ${groupId.slice(0, 8)}`);
            } catch (err) {
              console.warn(`[sat-ars-bot] command !${m[1]} failed:`, err?.message || err);
            }
          },
        },
      );
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
        { kind: 9021, created_at: Math.floor(Date.now() / 1000), tags: [['h', groupId]], content: 'sat-ars bot join' },
        sk,
      );
      try {
        await Promise.any(pool.publish([relay], join));
        console.log(`[sat-ars-bot] join-request sent: ${relay} ${groupId.slice(0, 8)}`);
        state.joined[key] = Math.floor(Date.now() / 1000);
        saveState(state);
      } catch (err) {
        console.warn(`[sat-ars-bot] join-request failed on ${relay}:`, err?.message || err);
      }
    }
    if (!state.greeted[key]) {
      const hello = finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['h', groupId]],
          content: '🇦🇷 sat-ars bot online — try !sat, !btc, !ars, !stats, !help.',
        },
        sk,
      );
      try {
        await Promise.any(pool.publish([relay], hello));
        console.log(`[sat-ars-bot] hello sent: ${relay} ${groupId.slice(0, 8)}`);
        state.greeted[key] = Math.floor(Date.now() / 1000);
        saveState(state);
      } catch (err) {
        console.warn(`[sat-ars-bot] hello failed on ${relay} (likely not admitted yet):`, err?.message || err);
      }
    } else {
      console.log(`[sat-ars-bot] hello already sent for ${relay} ${groupId.slice(0, 8)} — skipping`);
    }
  }

  // ── Price tick: kind:0 ticker, optional periodic kind 9 summary ─────
  // Dedup on the *displayed* string, not the raw float — at ~1.2 ARS/sat the
  // 4th decimal flickers constantly without the user ever seeing a change.
  let lastDisplay = null;
  let priceChangeCount = 0;
  const tick = async () => {
    let s;
    try {
      s = await fetchStats();
    } catch (err) {
      console.warn('[sat-ars-bot] tick fetch failed:', err?.message || err);
      return;
    }
    const priceStr = fmtAr2(s.arsPerSat);
    const name = TEMPLATE.replace('${price}', priceStr);
    if (name === lastDisplay) return;
    lastDisplay = name;
    priceChangeCount += 1;

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
      console.log(`[sat-ars-bot] kind:0 → ${name}  (BTC $${fmtUs0(s.usdPerBtc)} · USD/ARS ${fmtAr0(s.arsPerUsd)})`);
    } catch (err) {
      console.warn('[sat-ars-bot] kind:0 publish failed:', err?.message || err);
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
          console.log(`[sat-ars-bot] kind:9 → ${relay} ${groupId.slice(0, 8)}`);
        } catch (err) {
          console.warn(`[sat-ars-bot] kind:9 publish failed on ${relay}:`, err?.message || err);
        }
      }
    }
  };

  await tick();
  setInterval(tick, INTERVAL);
}

main().catch((err) => {
  console.error('[sat-ars-bot] fatal:', err);
  process.exit(1);
});
