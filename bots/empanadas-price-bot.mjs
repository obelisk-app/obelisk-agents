#!/usr/bin/env node
// Checks one public Buenos Aires menu and publishes the price of an empanada.

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { createStateStore } from '../lib/state.mjs';

const PREFIX = 'empanadas-price-bot';
const SOURCE_URL = process.env.EMPANADAS_PRICE_BOT_SOURCE_URL || process.env.BOT_SOURCE_URL
  || 'https://www.rappi.com.ar/restaurantes/180630-tienda-de-empanadas/ubicacion';
const ITEM_NAME = process.env.EMPANADAS_PRICE_BOT_ITEM_NAME || process.env.BOT_ITEM_NAME
  || 'Empanada de Carne Suave';
const INTERVAL_MS = Math.max(60_000, Number(
  process.env.EMPANADAS_PRICE_BOT_INTERVAL_MS || process.env.BOT_INTERVAL_MS,
) || 6 * 60 * 60_000);
const TIMEOUT_MS = Math.max(1_000, Number(
  process.env.EMPANADAS_PRICE_BOT_TIMEOUT_MS || process.env.BOT_TIMEOUT_MS,
) || 10_000);
const MAX_BACKOFF_MS = Math.max(INTERVAL_MS, Number(
  process.env.EMPANADAS_PRICE_BOT_MAX_BACKOFF_MS || process.env.BOT_MAX_BACKOFF_MS,
) || 24 * 60 * 60_000);
const RELAYS = (process.env.EMPANADAS_PRICE_BOT_RELAYS || process.env.BOT_RELAYS
  || 'wss://relay.obelisk.ar').split(',').map((s) => s.trim()).filter(Boolean);
const GROUPS = parseGroupList(process.env.EMPANADAS_PRICE_BOT_GROUPS || process.env.BOT_GROUPS);

function findMenuItem(value) {
  if (!value || typeof value !== 'object') return null;
  if (value['@type'] === 'MenuItem' && value.name === ITEM_NAME) {
    const price = Number(value.offers?.price);
    if (Number.isFinite(price) && price > 0) return { name: value.name, price };
  }
  for (const child of Object.values(value)) {
    const found = findMenuItem(child);
    if (found) return found;
  }
  return null;
}

function parsePrice(html) {
  const json = html.match(/<script[^>]+id=["']seo-structured-schema["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!json) throw new Error('menu schema not found');
  const item = findMenuItem(JSON.parse(json));
  if (!item) throw new Error(`menu item not found: ${ITEM_NAME}`);
  return item;
}

async function fetchPrice() {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'ObeliskEmpanadasPriceBot/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`source HTTP ${response.status}`);
  return parsePrice(await response.text());
}

const ars = (price) => `$${price.toLocaleString('es-AR')} ARS`;
const summary = ({ name, price }) => `🥟 ${name}: ${ars(price)} en Villa Devoto, CABA · Fuente: ${SOURCE_URL}`;

async function main() {
  const nsecEnv = process.env.EMPANADAS_PRICE_BOT_NSEC ? 'EMPANADAS_PRICE_BOT_NSEC' : 'BOT_NSEC';
  const { sk, pk, npub } = identityFromEnv(nsecEnv);
  const pool = createPool(sk);
  const { loadState, saveState } = createStateStore({
    fileName: 'obelisk-empanadas-price-bot-state.json',
    envName: process.env.EMPANADAS_PRICE_BOT_STATE_PATH
      ? 'EMPANADAS_PRICE_BOT_STATE_PATH' : 'BOT_STATE_PATH',
    logPrefix: PREFIX,
  });
  const state = loadState();
  state.groupPrices ||= {};
  const seen = new Set();
  let stopped = false;
  let timer;
  let failures = 0;

  console.log(`[${PREFIX}] running as ${npub}`);
  console.log(`[${PREFIX}] relays: ${RELAYS.join(', ')}`);
  console.log(`[${PREFIX}] groups: ${GROUPS.map((g) => `${g.relay}|${g.groupId}`).join(', ') || '(none)'}`);
  console.log(`[${PREFIX}] checking every ${INTERVAL_MS}ms: ${SOURCE_URL}`);

  const publish = async (relays, kind, tags, content) => {
    const event = finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
    await Promise.any(pool.publish(relays, event));
  };

  const update = async () => {
    const item = await fetchPrice();
    state.latest = { ...item, checkedAt: Math.floor(Date.now() / 1000) };
    console.log(`[${PREFIX}] checked: ${item.name} ${ars(item.price)}`);

    if (state.profilePrice !== item.price) {
      const name = `Empanada ${ars(item.price)}`;
      try {
        await publish(RELAYS, 0, [], JSON.stringify({ name, display_name: name, about: summary(item) }));
        state.profilePrice = item.price;
        console.log(`[${PREFIX}] profile updated: ${name}`);
      } catch (err) {
        console.warn(`[${PREFIX}] profile publish failed:`, err?.message || err);
      }
    }
    for (const { relay, groupId } of GROUPS) {
      const key = `${relay}|${groupId}`;
      if (state.groupPrices[key] === item.price) continue;
      try {
        await publish([relay], 9, [['h', groupId]], summary(item));
        state.groupPrices[key] = item.price;
      } catch (err) {
        console.warn(`[${PREFIX}] group publish failed on ${relay}:`, err?.message || err);
      }
    }
    saveState(state);
  };

  const schedule = async () => {
    try {
      await update();
      failures = 0;
    } catch (err) {
      failures += 1;
      console.warn(`[${PREFIX}] check failed:`, err?.message || err);
    }
    if (!stopped) {
      const delay = Math.min(MAX_BACKOFF_MS, INTERVAL_MS * (2 ** failures));
      timer = setTimeout(schedule, delay);
    }
  };

  for (const { relay, groupId } of GROUPS) {
    let since = Math.floor(Date.now() / 1000) - 5;
    const subscribe = () => {
      if (stopped) return;
      pool.subscribe([relay], { kinds: [9], '#h': [groupId], since }, {
        onauth: async () => null,
        onclose: () => {
          since = Math.floor(Date.now() / 1000);
          if (!stopped) setTimeout(subscribe, 1_500);
        },
        onevent: async (event) => {
          since = Math.max(since, event.created_at);
          if (event.pubkey === pk || seen.has(event.id)) return;
          seen.add(event.id);
          if (seen.size > 5_000) seen.delete(seen.values().next().value);
          if (!/^!empanada\b/i.test(event.content.trim())) return;
          try {
            const item = state.latest || await fetchPrice();
            await publish([relay], 9, [['h', groupId], ['e', event.id], ['p', event.pubkey]], summary(item));
          } catch (err) {
            console.warn(`[${PREFIX}] command failed:`, err?.message || err);
          }
        },
      });
    };
    subscribe();
  }

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    pool.close([...new Set([...RELAYS, ...GROUPS.map((group) => group.relay)])]);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await schedule();
}

if (process.argv.includes('--self-test')) {
  const item = parsePrice(`<script id="seo-structured-schema">{"hasMenu":{"@type":"MenuItem","name":"${ITEM_NAME}","offers":{"price":2200}}}</script>`);
  if (item.price !== 2200) throw new Error('self-test failed');
  console.log('self-test passed');
} else {
  main().catch((err) => {
    console.error(`[${PREFIX}] fatal:`, err?.message || err);
    process.exit(1);
  });
}
