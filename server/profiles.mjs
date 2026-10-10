// Nostr profile (kind 0) cache for the dashboard: bot avatars, names and
// bios as they currently are on Nostr, plus the signed-in admin's own.
//
// One anonymous REQ per refresh for every pubkey we care about (authors
// filter), against public profile relays — the Obelisk relays are
// whitelisted and would refuse an anonymous reader. Results are cached;
// callers get whatever is cached immediately and a refresh is kicked off
// in the background when it goes stale, so /api/bots never waits on relays.
import fs from 'node:fs';
import path from 'node:path';
import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

import { stateDir } from './config.mjs';

useWebSocketImplementation(WebSocket);

const PROFILE_RELAYS = (process.env.MANAGER_PROFILE_RELAYS
  ?? 'wss://purplepag.es,wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TTL_MS = 2 * 60_000; // profiles also change outside the UI (price-bot, CLI publishes)
const QUERY_TIMEOUT_MS = 8_000;

// Relays forget profiles (purplepag.es prunes keys outside its web of
// trust, others expire old events), so the last-known copy is persisted:
// a bot keeps its face on the dashboard, flagged via `seenAt` as no longer
// found so it can be republished.
const cachePath = path.join(stateDir, 'profiles.json');
const cache = new Map(loadCache()); // pubkey -> { at, profile | null }

function loadCache() {
  try {
    // `at: 0` → everything is refreshed once after a restart.
    return Object.entries(JSON.parse(fs.readFileSync(cachePath, 'utf8')))
      .map(([pk, profile]) => [pk, { at: 0, profile }]);
  } catch {
    return [];
  }
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const out = Object.fromEntries([...cache].map(([pk, v]) => [pk, v.profile]));
    fs.writeFileSync(cachePath, JSON.stringify(out));
  } catch (err) {
    console.warn('[profiles] cache save failed:', err?.message || err);
  }
}
const wanted = new Set();
let inFlight = null;

function pick(meta) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
  return {
    name: str(meta.name),
    display_name: str(meta.display_name) ?? str(meta.displayName),
    picture: /^https?:\/\//.test(meta.picture ?? '') ? str(meta.picture) : null,
    banner: /^https?:\/\//.test(meta.banner ?? '') ? str(meta.banner) : null,
    about: str(meta.about),
    nip05: str(meta.nip05),
    lud16: str(meta.lud16),
    website: str(meta.website),
  };
}

// Collects events as they arrive and settles at EOSE from every relay or
// at the timeout — whichever comes first — so one slow relay can't discard
// what the fast ones already returned.
function collect(pool, relays, filter) {
  return new Promise((resolve) => {
    const events = [];
    let sub;
    const done = () => {
      clearTimeout(timer);
      try { sub?.close(); } catch {}
      resolve(events);
    };
    const timer = setTimeout(done, QUERY_TIMEOUT_MS);
    sub = pool.subscribe(relays, filter, { onevent: (ev) => events.push(ev), oneose: done });
  });
}

async function refresh(pubkeys) {
  const pool = new SimplePool();
  try {
    const events = await collect(pool, PROFILE_RELAYS, { kinds: [0], authors: pubkeys });
    const newest = new Map();
    for (const ev of events) {
      if (!newest.has(ev.pubkey) || newest.get(ev.pubkey).created_at < ev.created_at) newest.set(ev.pubkey, ev);
    }
    const now = Date.now();
    for (const pk of pubkeys) {
      const ev = newest.get(pk);
      let profile = cache.get(pk)?.profile ?? null;
      if (ev) {
        try { profile = { ...pick(JSON.parse(ev.content)), updatedAt: ev.created_at, seenAt: Math.floor(now / 1000) }; } catch {}
      }
      cache.set(pk, { at: now, profile });
    }
    saveCache();
  } finally {
    try { pool.close(PROFILE_RELAYS); } catch {}
  }
}

function kick() {
  if (inFlight) return inFlight;
  const stale = [...wanted].filter((pk) => Date.now() - (cache.get(pk)?.at ?? 0) > TTL_MS);
  if (!stale.length) return Promise.resolve();
  inFlight = refresh(stale)
    .catch((err) => console.warn('[profiles] refresh failed:', err?.message || err))
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Cached profiles for these pubkeys (null = unknown yet / no kind 0).
 * With `wait`, a first-ever lookup waits for the relays (bounded by the
 * query timeout) instead of returning empty.
 */
export async function profilesFor(pubkeys, { wait = false } = {}) {
  const list = pubkeys.filter(Boolean);
  for (const pk of list) wanted.add(pk);
  const p = kick();
  if (wait && list.some((pk) => !cache.has(pk))) await p;
  return Object.fromEntries(list.map((pk) => [pk, cache.get(pk)?.profile ?? null]));
}

/** Drop a pubkey's cache entry (after we publish a new kind 0 for it). */
export function invalidateProfile(pubkey, profile) {
  const now = Math.floor(Date.now() / 1000);
  if (profile) cache.set(pubkey, { at: Date.now(), profile: { ...pick(profile), updatedAt: now, seenAt: now } });
  else cache.delete(pubkey);
  saveCache();
}

/**
 * The newest kind 0 content for one pubkey, fresh from the relays and
 * unfiltered (every field, including ones the dashboard ignores), so a
 * merge-and-republish never drops anything. {} when none is found.
 */
export async function fetchRawProfile(pubkey) {
  const pool = new SimplePool();
  try {
    const events = await collect(pool, PROFILE_RELAYS, { kinds: [0], authors: [pubkey] });
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) return {};
    const raw = JSON.parse(newest.content);
    cache.set(pubkey, { at: Date.now(), profile: { ...pick(raw), updatedAt: newest.created_at, seenAt: Math.floor(Date.now() / 1000) } });
    saveCache();
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  } finally {
    try { pool.close(PROFILE_RELAYS); } catch {}
  }
}
