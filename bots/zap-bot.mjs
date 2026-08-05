#!/usr/bin/env node
// Obelisk zap-bot — listens for zap receipts (kind 9735) and
// group-local zap reactions (kind 7, "⚡") in NIP-29 groups and announces
// them in chat:
//   "⚡ @alice sent 420 satoshis to @bob"
//
// Two ways the bot picks which groups to watch:
//   • Static (ZAP_BOT_GROUPS): comma-separated `relayUrl|groupId` pairs.
//   • Dynamic (ZAP_BOT_LISTEN_RELAYS): relays to scan for kind 39000 and
//     auto-subscribe to every open group found. Refreshed every
//     ZAP_BOT_REFRESH_MS (default 10 min). Closed groups are skipped
//     because the bot can't post into them without an explicit admit.
//
// How a zap reaches the group
//   1. Alice's NIP-29-aware client builds a kind 9734 zap request whose
//      tags include ["h", groupId] alongside ["p", bobHex], ["e", msgId],
//      ["amount", millisats], ["relays", "wss://public.obelisk.ar", ...].
//   2. Alice's wallet pays the bolt11.
//   3. Some clients publish a group-local kind 7 "⚡" reaction with h/e/p
//      tags plus bolt11 or amount metadata. Some LNURL providers publish a
//      kind 9735 zap receipt to the relays listed in the request.
//   4. If the relay accepts and stores either event, the bot's #h-filtered
//      subscription delivers it.
//
// Configuration — see .env.example.

import { finalizeEvent, nip19 } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { createGroupWatcher } from '../lib/group-watcher.mjs';
import { createStateStore } from '../lib/state.mjs';

const { loadState, saveState, statePath } = createStateStore({
  fileName: 'obelisk-zap-bot-state.json',
  envName: 'ZAP_BOT_STATE_PATH',
  logPrefix: 'zap-bot',
});

const ENV_NAME = process.env.ZAP_BOT_NSEC ? 'ZAP_BOT_NSEC' : 'BOT_NSEC';

const MIN_SATS = Math.max(0, Number(process.env.ZAP_BOT_MIN_SATS) || 1);
const TEMPLATE = process.env.ZAP_BOT_TEMPLATE
  || '⚡ ${sender} sent ${amount} ${unit} to ${recipient}';

const RELAYS = (process.env.ZAP_BOT_RELAYS || process.env.BOT_RELAYS || 'wss://public.obelisk.ar')
  .split(',').map((s) => s.trim()).filter(Boolean);

const STATIC_GROUPS = parseGroupList(process.env.ZAP_BOT_GROUPS || process.env.BOT_GROUPS);

const LISTEN_RELAYS = (process.env.ZAP_BOT_LISTEN_RELAYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const REFRESH_MS = Math.max(60_000, Number(process.env.ZAP_BOT_REFRESH_MS) || 600_000);
const RECONNECT_BASE_MS = Math.max(2_000, Number(process.env.ZAP_BOT_RECONNECT_MS) || 10_000);
const HELLO_THROTTLE_MS = Math.max(500, Number(process.env.ZAP_BOT_HELLO_THROTTLE_MS) || 4_000);
const HELLO_ENABLED = process.env.ZAP_BOT_HELLO !== '0';
const HEARTBEAT_MS = Math.max(30_000, Number(process.env.ZAP_BOT_HEARTBEAT_MS) || 300_000);
const SEEN_MAX = Math.max(100, Number(process.env.ZAP_BOT_SEEN_MAX) || 10_000);
const ERROR_COOLDOWN_MS = 60 * 60 * 1000;
const ZAP_KINDS = [7, 9735];

// ── BOLT-11 amount parser ───────────────────────────────────────────
// Spec: `ln{network}{amount}{multiplier}1{data}` where multiplier ∈ {m,u,n,p}.
// 1 BTC = 1e8 sats = 1e11 msats. Returns msats or null.
function bolt11AmountMsat(bolt11) {
  if (!bolt11) return null;
  const m = /^ln[a-z]{2,5}(?:(\d+)([munp]?))?1/i.exec(bolt11);
  if (!m || !m[1]) return null;
  const amount = BigInt(m[1]);
  switch ((m[2] || '').toLowerCase()) {
    case 'm': return Number(amount * 100_000_000n);
    case 'u': return Number(amount * 100_000n);
    case 'n': return Number(amount * 100n);
    case 'p': return Number(amount / 10n);
    case '':  return Number(amount * 100_000_000_000n);
    default:  return null;
  }
}

function tagValue(tags, name) {
  if (!Array.isArray(tags)) return null;
  const t = tags.find((x) => x[0] === name);
  return t ? t[1] : null;
}

function tagByName(tags, name) {
  if (!Array.isArray(tags)) return null;
  return tags.find((x) => x[0] === name) || null;
}

function parseDescription(desc) {
  if (!desc) return null;
  try {
    const v = JSON.parse(desc);
    return v && typeof v === 'object' && Array.isArray(v.tags) ? v : null;
  } catch { return null; }
}

function amountValueSats(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const normalized = String(unit || '').toLowerCase();
  const sats = ['sat', 'sats', 'satoshi', 'satoshis'].includes(normalized)
    ? v
    : v / 1000;
  const wholeSats = Math.floor(sats);
  return wholeSats > 0 ? wholeSats : null;
}

function amountTagSats(tags, name, defaultUnit = 'msat') {
  const t = tagByName(tags, name);
  if (!t) return null;
  return amountValueSats(t[1], t[2] || defaultUnit);
}

function receiptAmountSats(receipt, zapReq) {
  const r1 = amountTagSats(receipt.tags, 'amount');
  if (r1) return r1;
  if (zapReq) {
    const r2 = amountTagSats(zapReq.tags, 'amount');
    if (r2) return r2;
  }
  const msat = bolt11AmountMsat(tagValue(receipt.tags, 'bolt11'));
  if (msat) return Math.floor(msat / 1000);
  return null;
}

function reactionAmountSats(reaction) {
  const bolt11 = bolt11AmountMsat(tagValue(reaction.tags, 'bolt11'));
  if (bolt11) {
    const sats = Math.floor(bolt11 / 1000);
    if (sats > 0) return sats;
  }
  return amountTagSats(reaction.tags, 'amount')
    || amountTagSats(reaction.tags, 'msat')
    || amountTagSats(reaction.tags, 'msats')
    || amountTagSats(reaction.tags, 'millisats')
    || amountTagSats(reaction.tags, 'sat', 'sat')
    || amountTagSats(reaction.tags, 'sats', 'sat');
}

function isZapReaction(ev) {
  return ev.kind === 7 && typeof ev.content === 'string' && ev.content.includes('⚡');
}

function zapCandidate(ev) {
  if (ev.kind === 9735) {
    const zapReq = parseDescription(tagValue(ev.tags, 'description'));
    return {
      type: 'receipt',
      groupIds: [tagValue(ev.tags, 'h'), zapReq && tagValue(zapReq.tags, 'h')].filter(Boolean),
      senderHex: tagValue(ev.tags, 'P') || (zapReq && zapReq.pubkey) || null,
      recipient: tagValue(ev.tags, 'p'),
      sats: receiptAmountSats(ev, zapReq),
      eTag: tagValue(ev.tags, 'e'),
    };
  }

  if (isZapReaction(ev)) {
    return {
      type: 'reaction',
      groupIds: [tagValue(ev.tags, 'h')].filter(Boolean),
      senderHex: ev.pubkey,
      recipient: tagValue(ev.tags, 'p'),
      sats: reactionAmountSats(ev),
      eTag: tagValue(ev.tags, 'e'),
    };
  }

  return null;
}

function shortNpub(hex) {
  try { return nip19.npubEncode(hex).slice(0, 12) + '…'; }
  catch { return hex.slice(0, 8) + '…'; }
}

const fmt = (n) => n.toLocaleString('en-US');

// FIFO-bounded set so the dedup cache doesn't grow unbounded.
function createSeenCache(max) {
  const set = new Set();
  const queue = [];
  return {
    has: (id) => set.has(id),
    add: (id) => {
      if (set.has(id)) return;
      set.add(id);
      queue.push(id);
      while (queue.length > max) set.delete(queue.shift());
    },
    size: () => set.size,
  };
}

let shuttingDown = false;
const cleanups = [];
function onShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[zap-bot] shutting down…');
  for (const fn of cleanups) { try { fn(); } catch {} }
  setTimeout(() => process.exit(0), 500);
}

async function main() {
  if (!process.env[ENV_NAME]) {
    console.log(`[zap-bot] ${ENV_NAME} not set — bot disabled.`);
    return;
  }
  const { sk, pk, npub } = identityFromEnv(ENV_NAME);

  console.log(`[zap-bot] env:             ${ENV_NAME}`);
  console.log(`[zap-bot] pubkey hex:      ${pk}`);
  console.log(`[zap-bot] pubkey npub:     ${npub}`);
  console.log(`[zap-bot] relays:          ${RELAYS.join(', ')}`);
  console.log(`[zap-bot] static groups:   ${STATIC_GROUPS.map((g) => `${g.relay}|${g.groupId}`).join(', ') || '(none)'}`);
  console.log(`[zap-bot] listen relays:   ${LISTEN_RELAYS.join(', ') || '(none)'}`);
  console.log(`[zap-bot] state:           ${statePath}`);
  console.log(`[zap-bot] zap kinds:       ${ZAP_KINDS.join(', ')}`);
  console.log(`[zap-bot] refresh:         ${REFRESH_MS}ms;  reconnect base ${RECONNECT_BASE_MS}ms`);
  console.log(`[zap-bot] min sats:        ${MIN_SATS}`);

  const pool = createPool(sk);

  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);

  // ── Name cache (pubkey hex → kind:0 name) ─────────────────────────
  const nameCache = new Map();
  const nameFetching = new Set();
  const nameRelays = Array.from(new Set([
    ...RELAYS,
    ...LISTEN_RELAYS,
    ...STATIC_GROUPS.map((g) => g.relay),
  ]));

  function fetchName(hex) {
    if (nameFetching.has(hex) || nameCache.has(hex)) return;
    nameFetching.add(hex);
    let resolved = false;
    let sub;
    const finish = () => { try { sub?.close(); } catch {} nameFetching.delete(hex); };
    sub = pool.subscribe(
      nameRelays,
      { kinds: [0], authors: [hex] },
      {
        onauth: async () => null,
        onevent: (ev) => {
          if (resolved) return;
          try {
            const meta = JSON.parse(ev.content);
            const name = meta.display_name || meta.displayName || meta.name;
            if (name && typeof name === 'string') {
              nameCache.set(hex, name.trim().slice(0, 40));
              resolved = true;
            }
          } catch {}
        },
        oneose: () => finish(),
        onclose: () => finish(),
      },
    );
    setTimeout(finish, 5000);
  }

  // Render mentions as `nostr:npub1…` so NIP-29 chat clients turn them
  // into proper user pills (per NIP-27). The kind:0 lookup still warms
  // the cache so clients that fall back to plain text get a name.
  function displayFor(hex) {
    if (!hex) return 'anonymous';
    if (!nameCache.has(hex)) fetchName(hex);
    try { return `nostr:${nip19.npubEncode(hex)}`; }
    catch { return hex.slice(0, 8) + '…'; }
  }

  // ── Stats + dedup ─────────────────────────────────────────────────
  const stats = { received: 0, receipts: 0, reactions: 0, announced: 0, filtered: 0, errors: 0, startedAt: Date.now() };
  const seen = createSeenCache(SEEN_MAX);
  const errorCooldown = new Map();

  function warnCooldown(key, msg) {
    const now = Date.now();
    const last = errorCooldown.get(key) || 0;
    if (now - last < ERROR_COOLDOWN_MS) return;
    errorCooldown.set(key, now);
    console.warn(msg);
  }

  // ── Zap event handler ─────────────────────────────────────────────
  async function handleZapEvent(ev, relay, groupId) {
    const zap = zapCandidate(ev);
    if (!zap) return;

    if (!zap.groupIds.includes(groupId)) {
      stats.filtered += 1;
      if (process.env.BOT_DEBUG === '1') {
        console.log(`[zap-bot] ${zap.type} ${ev.id.slice(0, 8)} not in group ${groupId.slice(0, 8)} — skip`);
      }
      return;
    }

    if (seen.has(ev.id)) return;
    seen.add(ev.id);
    stats.received += 1;
    if (zap.type === 'reaction') stats.reactions += 1;
    else stats.receipts += 1;

    const { recipient, senderHex, sats } = zap;
    if (sats == null) {
      console.warn(`[zap-bot] ${zap.type} ${ev.id.slice(0, 8)}: no parseable amount — skip`);
      stats.filtered += 1;
      return;
    }
    if (sats < MIN_SATS) { stats.filtered += 1; return; }
    if (!recipient) { stats.filtered += 1; return; }
    if (senderHex && senderHex === pk) { stats.filtered += 1; return; }
    if (recipient === pk) { stats.filtered += 1; return; }

    const senderDisplay = senderHex ? displayFor(senderHex) : '@anonymous';
    const recipientDisplay = displayFor(recipient);
    const unit = sats === 1 ? 'satoshi' : 'satoshis';
    const content = TEMPLATE
      .replaceAll('${sender}', senderDisplay)
      .replaceAll('${recipient}', recipientDisplay)
      .replaceAll('${amount}', fmt(sats))
      .replaceAll('${unit}', unit);

    const tags = [['h', groupId]];
    if (zap.eTag) tags.push(['e', zap.eTag]);
    if (senderHex) tags.push(['p', senderHex]);
    if (recipient && recipient !== senderHex) tags.push(['p', recipient]);

    const announcement = finalizeEvent({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    }, sk);

    try {
      await Promise.any(pool.publish([relay], announcement));
      stats.announced += 1;
      console.log(`[zap-bot] announced ${sats} ${unit} from ${zap.type}: ${senderDisplay} → ${recipientDisplay} on ${groupId.slice(0, 8)}`);
    } catch (err) {
      stats.errors += 1;
      warnCooldown(
        `announce|${relay}|${groupId}`,
        `[zap-bot] announce failed on ${relay} ${groupId.slice(0, 8)}: ${err?.message || err}`,
      );
    }
  }

  // ── Per-group reconnecting subscription ───────────────────────────
  // relay29 closes REQs after EOSE; reconnect with backoff + jitter and
  // an overlap-safe `since` so events in the reconnect gap aren't lost
  // (the seen-cache dedupes anything we re-receive).
  const subs = new Map();

  function subscribeGroup({ relay, groupId, name }) {
    const key = `${relay}|${groupId}`;
    if (subs.has(key)) return;
    let closed = false;
    let reconnectTimer = null;
    let lastEventAt = Math.floor(Date.now() / 1000);
    let since = lastEventAt - 30;

    const open = () => {
      if (closed) return;
      try {
        pool.subscribe([relay], { kinds: ZAP_KINDS, '#h': [groupId], since }, {
          onauth: async () => null,
          oneose: () => {
            if (process.env.BOT_DEBUG === '1') {
              console.log(`[zap-bot] sub EOSE ${relay} ${groupId.slice(0, 8)}`);
            }
          },
          onclose: () => {
            if (closed) return;
            since = Math.max(lastEventAt - 5, Math.floor(Date.now() / 1000) - 60);
            const delay = RECONNECT_BASE_MS + Math.floor(Math.random() * RECONNECT_BASE_MS);
            reconnectTimer = setTimeout(open, delay);
          },
          onevent: async (ev) => {
            lastEventAt = Math.max(lastEventAt, ev.created_at);
            try {
              await handleZapEvent(ev, relay, groupId);
            } catch (err) {
              stats.errors += 1;
              warnCooldown(
                `handle|${relay}|${groupId}`,
                `[zap-bot] handler error ${relay} ${groupId.slice(0, 8)}: ${err?.message || err}`,
              );
            }
          },
        });
      } catch (err) {
        warnCooldown(
          `sub|${relay}|${groupId}`,
          `[zap-bot] sub failed ${relay} ${groupId.slice(0, 8)}: ${err?.message || err}`,
        );
        reconnectTimer = setTimeout(open, RECONNECT_BASE_MS + Math.floor(Math.random() * RECONNECT_BASE_MS));
      }
    };
    // stagger initial connects so we don't open all sockets at once
    reconnectTimer = setTimeout(open, Math.floor(Math.random() * 2000));
    subs.set(key, { close: () => { closed = true; if (reconnectTimer) clearTimeout(reconnectTimer); } });
    console.log(`[zap-bot] +group ${relay} ${groupId.slice(0, 8)}${name ? ` (${name.slice(0, 32)})` : ''}`);
  }

  function unsubscribeGroup({ relay, groupId }) {
    const key = `${relay}|${groupId}`;
    const s = subs.get(key);
    if (!s) return;
    s.close();
    subs.delete(key);
    console.log(`[zap-bot] -group ${relay} ${groupId.slice(0, 8)}`);
  }

  cleanups.push(() => { for (const s of subs.values()) { try { s.close(); } catch {} } });

  // ── Throttled join + hello queue ──────────────────────────────────
  // Run sequentially with HELLO_THROTTLE_MS between groups so a fresh
  // bot joining 50 groups doesn't hammer the relay.
  const state = loadState();
  state.joined ||= {};
  state.greeted ||= {};
  const helloQueue = [];
  let helloRunning = false;

  async function runHelloQueue() {
    if (helloRunning) return;
    helloRunning = true;
    while (helloQueue.length > 0 && !shuttingDown) {
      const { relay, groupId } = helloQueue.shift();
      const key = `${relay}|${groupId}`;

      // If we've ever successfully greeted this group, we can post in it,
      // which is enough — skip the 9021 (some relays reject duplicates
      // and the resulting AUTH-race noise is meaningless).
      if (!state.joined[key] && !state.greeted[key]) {
        const join = finalizeEvent(
          { kind: 9021, created_at: Math.floor(Date.now() / 1000), tags: [['h', groupId]], content: 'zap bot join' },
          sk,
        );
        try {
          await Promise.any(pool.publish([relay], join));
          state.joined[key] = Math.floor(Date.now() / 1000);
          saveState(state);
          console.log(`[zap-bot] join-request sent: ${relay} ${groupId.slice(0, 8)}`);
        } catch (err) {
          console.warn(`[zap-bot] join-request failed on ${relay} ${groupId.slice(0, 8)}: ${err?.message || err}`);
        }
      }

      if (HELLO_ENABLED && !state.greeted[key]) {
        const hello = finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['h', groupId]],
            content: '⚡ zap bot online — I will announce zaps as they happen in this group.',
          },
          sk,
        );
        try {
          await Promise.any(pool.publish([relay], hello));
          state.greeted[key] = Math.floor(Date.now() / 1000);
          saveState(state);
          console.log(`[zap-bot] hello sent: ${relay} ${groupId.slice(0, 8)}`);
        } catch (err) {
          console.warn(`[zap-bot] hello failed on ${relay} ${groupId.slice(0, 8)}: ${err?.message || err}`);
        }
      }

      await new Promise((r) => setTimeout(r, HELLO_THROTTLE_MS));
    }
    helloRunning = false;
  }

  function enqueueHello(group) {
    const key = `${group.relay}|${group.groupId}`;
    const joinedDone = !!state.joined[key] || !!state.greeted[key];
    const greetDone = !HELLO_ENABLED || !!state.greeted[key];
    if (joinedDone && greetDone) return;
    helloQueue.push(group);
    runHelloQueue();
  }

  // ── Wire up static groups ─────────────────────────────────────────
  for (const g of STATIC_GROUPS) {
    subscribeGroup({ relay: g.relay, groupId: g.groupId });
    enqueueHello({ relay: g.relay, groupId: g.groupId });
  }

  // ── Wire up dynamic groups via watcher ────────────────────────────
  let watcher = null;
  if (LISTEN_RELAYS.length > 0) {
    watcher = createGroupWatcher(pool, LISTEN_RELAYS, {
      refreshMs: REFRESH_MS,
      filter: (g) => g.isOpen,
      onAdd: (g) => {
        subscribeGroup(g);
        enqueueHello(g);
      },
      onRemove: (g) => unsubscribeGroup(g),
    });
    cleanups.push(() => watcher.stop());
  }

  // ── Heartbeat ─────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    const uptimeMin = Math.floor((Date.now() - stats.startedAt) / 60000);
    console.log(
      `[zap-bot] alive — ${subs.size} groups, ${stats.received} zap events `
      + `(${stats.receipts} receipts, ${stats.reactions} reactions), `
      + `${stats.announced} announced, ${stats.filtered} filtered, ${stats.errors} errors, `
      + `${seen.size()} cached, up ${uptimeMin}m`,
    );
  }, HEARTBEAT_MS);
  cleanups.push(() => clearInterval(heartbeat));
}

main().catch((err) => {
  console.error('[zap-bot] fatal:', err);
  process.exit(1);
});
