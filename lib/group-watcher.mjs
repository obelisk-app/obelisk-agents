// Periodic NIP-29 group discovery.
//
// Subscribes to kind 39000 (group metadata) on a set of relays and
// maintains a live view of which groups exist. Fires onAdd/onRemove
// callbacks as groups appear or disappear between refreshes.
//
// Usage:
//   const watcher = createGroupWatcher(pool, ['wss://relay.example'], {
//     refreshMs: 600_000,
//     perRelayTimeoutMs: 8_000,
//     filter: (g) => g.isOpen,           // optional, default: all
//     onAdd:    ({ relay, groupId, name, isOpen, isPublic }) => { ... },
//     onRemove: ({ relay, groupId }) => { ... },
//   });
//   watcher.groups();    // → snapshot of known groups
//   watcher.refreshNow();
//   watcher.stop();

export function createGroupWatcher(pool, relays, {
  refreshMs = 600_000,
  perRelayTimeoutMs = 8_000,
  filter = null,
  onAdd = null,
  onRemove = null,
} = {}) {
  // key = "relay|groupId" → { relay, groupId, name, isOpen, isPublic, created_at }
  const known = new Map();
  let stopped = false;
  let timer = null;
  let inFlight = null;

  async function scanRelay(relay) {
    const seen = new Map();
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; try { sub?.close(); } catch {} resolve(); } };
      const sub = pool.subscribe([relay], { kinds: [39000] }, {
        onauth: async () => null,
        onevent: (ev) => {
          const tag = (k) => ev.tags.find((t) => t[0] === k)?.[1];
          const groupId = tag('d');
          if (!groupId) return;
          const prev = seen.get(groupId);
          if (prev && prev.created_at >= ev.created_at) return;
          seen.set(groupId, {
            relay,
            groupId,
            name: tag('name') || '',
            isOpen: !!ev.tags.find((t) => t[0] === 'open'),
            isPublic: !!ev.tags.find((t) => t[0] === 'public'),
            created_at: ev.created_at,
          });
        },
        oneose: finish,
        onclose: finish,
      });
      setTimeout(finish, perRelayTimeoutMs);
    });
    return seen;
  }

  async function refresh() {
    if (stopped) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const fresh = new Map();
      const results = await Promise.all(
        relays.map((r) => scanRelay(r).catch((err) => {
          console.warn(`[group-watcher] scan failed on ${r}:`, err?.message || err);
          return new Map();
        })),
      );
      for (let i = 0; i < relays.length; i++) {
        for (const [groupId, info] of results[i]) {
          if (filter && !filter(info)) continue;
          fresh.set(`${relays[i]}|${groupId}`, info);
        }
      }
      if (stopped) return;

      for (const [key, info] of fresh) {
        if (!known.has(key)) {
          known.set(key, info);
          try { onAdd?.(info); }
          catch (err) { console.warn('[group-watcher] onAdd:', err?.message || err); }
        } else {
          // update metadata fields in place (name may have changed)
          known.set(key, info);
        }
      }
      for (const key of [...known.keys()]) {
        if (!fresh.has(key)) {
          const info = known.get(key);
          known.delete(key);
          try { onRemove?.(info); }
          catch (err) { console.warn('[group-watcher] onRemove:', err?.message || err); }
        }
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  // initial scan happens immediately; schedule periodic refresh
  const initial = refresh();
  timer = setInterval(refresh, refreshMs);

  return {
    ready: () => initial,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    groups: () => [...known.values()],
    refreshNow: refresh,
  };
}
