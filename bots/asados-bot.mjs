#!/usr/bin/env node
// Answers !asado with the price per kilo of a representative asado cut at DIA Argentina.

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { advertiseCommands } from '../lib/commands.mjs';
import { createStateStore } from '../lib/state.mjs';
import { createGroupWatcher } from '../lib/group-watcher.mjs';

const PREFIX = 'asados-bot';
const SOURCE_URL = process.env.ASADOS_BOT_SOURCE_URL || process.env.BOT_SOURCE_URL
  || 'https://diaonline.supermercadosdia.com.ar/tapa-de-asado-envasado-al-vacio-x-kg-279530/p';
const INTERVAL_MS = Math.max(15 * 60_000, Number(
  process.env.ASADOS_BOT_INTERVAL_MS || process.env.BOT_INTERVAL_MS,
) || 6 * 60 * 60_000);
const TIMEOUT_MS = Math.max(1_000, Number(
  process.env.ASADOS_BOT_TIMEOUT_MS || process.env.BOT_TIMEOUT_MS,
) || 10_000);
const MAX_BACKOFF_MS = Math.max(INTERVAL_MS, Number(
  process.env.ASADOS_BOT_MAX_BACKOFF_MS || process.env.BOT_MAX_BACKOFF_MS,
) || 24 * 60 * 60_000);
const REFRESH_MS = Math.max(60_000, Number(
  process.env.ASADOS_BOT_REFRESH_MS || process.env.BOT_REFRESH_MS,
) || 10 * 60_000);
const RELAYS = (process.env.ASADOS_BOT_RELAYS || process.env.BOT_RELAYS
  || 'wss://public.obelisk.ar').split(',').map((value) => value.trim()).filter(Boolean);
const GROUPS = parseGroupList(process.env.ASADOS_BOT_GROUPS || process.env.BOT_GROUPS);
const LISTEN_RELAYS = (process.env.ASADOS_BOT_LISTEN_RELAYS || process.env.BOT_LISTEN_RELAYS
  || (GROUPS.length ? '' : RELAYS.join(','))).split(',').map((value) => value.trim()).filter(Boolean);
const USER_AGENT = process.env.ASADOS_BOT_USER_AGENT || process.env.BOT_USER_AGENT
  || 'Mozilla/5.0 (compatible; Obelisk asados bot)';

function findProduct(value) {
  if (!value || typeof value !== 'object') return null;
  if (value['@type'] === 'Product') return value;
  for (const child of Object.values(value)) {
    const product = findProduct(child);
    if (product) return product;
  }
  return null;
}

function parseProduct(html) {
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let product;
    try { product = findProduct(JSON.parse(match[1])); } catch { continue; }
    if (!product) continue;
    const price = Number(product.offers?.lowPrice ?? product.offers?.price);
    if (Number.isFinite(price) && price > 0) return { name: product.name, price };
  }
  throw new Error('product price not found');
}

async function fetchProduct() {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`source HTTP ${response.status}`);
  return parseProduct(await response.text());
}

const ars = (price) => `$${price.toLocaleString('es-AR')} ARS`;
const summary = (item) => `🥩 ${item.name}: ${ars(item.price)} · Precio por kg · Fuente: ${SOURCE_URL}`;

async function main() {
  const nsecEnv = process.env.ASADOS_BOT_NSEC ? 'ASADOS_BOT_NSEC' : 'BOT_NSEC';
  const { sk, pk, npub } = identityFromEnv(nsecEnv);
  const pool = createPool(sk);
  const commandList = advertiseCommands({ pool, sk, relays: [...GROUPS.map((g) => g.relay), ...LISTEN_RELAYS], script: import.meta.url });
  const { loadState, saveState } = createStateStore({
    fileName: 'obelisk-asados-bot-state.json',
    envName: process.env.ASADOS_BOT_STATE_PATH ? 'ASADOS_BOT_STATE_PATH' : 'BOT_STATE_PATH',
    logPrefix: PREFIX,
  });
  const state = loadState();
  const seen = new Set();
  const subscriptions = new Map();
  let stopped = false;
  let timer;
  let failures = 0;

  console.log(`[${PREFIX}] running as ${npub}`);
  console.log(`[${PREFIX}] relays: ${RELAYS.join(', ')}`);
  console.log(`[${PREFIX}] groups: ${GROUPS.map((group) => `${group.relay}|${group.groupId}`).join(', ') || '(dynamic open groups)'}`);
  console.log(`[${PREFIX}] checking every ${INTERVAL_MS}ms: ${SOURCE_URL}`);

  const publish = async (relay, tags, content) => {
    const event = finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
    await Promise.any(pool.publish([relay], event));
  };

  const subscribeGroup = ({ relay, groupId }) => {
    const key = `${relay}|${groupId}`;
    if (subscriptions.has(key)) return;
    let closed = false;
    let sub;
    let since = Math.floor(Date.now() / 1000) - 5;
    const open = () => {
      if (closed) return;
      sub = pool.subscribe([relay], { kinds: [9], '#h': [groupId], since }, {
        onauth: async () => null,
        onclose: () => {
          since = Math.floor(Date.now() / 1000);
          if (!closed) setTimeout(open, 1_500);
        },
        onevent: async (event) => {
          since = Math.max(since, event.created_at);
          if (event.pubkey === pk || seen.has(event.id)) return;
          seen.add(event.id);
          if (seen.size > 5_000) seen.delete(seen.values().next().value);
          if (!/^!asado\b/i.test(event.content.trim())) return;
          let reply;
          try {
            const item = state.latest || await fetchProduct();
            reply = summary(item);
          } catch (err) {
            console.warn(`[${PREFIX}] command failed:`, err?.message || err);
            reply = '🥩 No pude consultar el precio del asado ahora. Probá de nuevo en un rato.';
          }
          try {
            await publish(relay, [['h', groupId], ['e', event.id], ['p', event.pubkey]], reply);
          } catch (err) {
            console.warn(`[${PREFIX}] reply rejected:`, err?.message || err);
          }
        },
      });
    };
    subscriptions.set(key, { close: () => { closed = true; sub?.close(); } });
    open();
  };

  const unsubscribeGroup = ({ relay, groupId }) => {
    const key = `${relay}|${groupId}`;
    subscriptions.get(key)?.close();
    subscriptions.delete(key);
  };

  for (const group of GROUPS) subscribeGroup(group);
  const watcher = LISTEN_RELAYS.length ? createGroupWatcher(pool, LISTEN_RELAYS, {
    refreshMs: REFRESH_MS,
    filter: (group) => group.isOpen,
    onAdd: subscribeGroup,
    onRemove: unsubscribeGroup,
  }) : null;

  const schedule = async () => {
    try {
      const item = await fetchProduct();
      state.latest = { ...item, checkedAt: Math.floor(Date.now() / 1000) };
      saveState(state);
      failures = 0;
      console.log(`[${PREFIX}] checked: ${item.name} ${ars(item.price)}`);
    } catch (err) {
      failures += 1;
      console.warn(`[${PREFIX}] check failed:`, err?.message || err);
    }
    if (!stopped) timer = setTimeout(schedule, Math.min(MAX_BACKOFF_MS, INTERVAL_MS * (2 ** failures)));
  };

  const stop = async () => {
    await commandList.stop();
    stopped = true;
    clearTimeout(timer);
    watcher?.stop();
    for (const subscription of subscriptions.values()) subscription.close();
    pool.close([...new Set([...RELAYS, ...GROUPS.map((group) => group.relay), ...LISTEN_RELAYS])]);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await schedule();
}

if (process.argv.includes('--self-test')) {
  const item = parseProduct('<script type="application/ld+json">{"@type":"Product","name":"Asado x Kg","offers":{"lowPrice":20900}}</script>');
  if (item.price !== 20900 || item.name !== 'Asado x Kg') throw new Error('self-test failed');
  console.log('self-test passed');
} else {
  main().catch((err) => {
    console.error(`[${PREFIX}] fatal:`, err?.message || err);
    process.exit(1);
  });
}
