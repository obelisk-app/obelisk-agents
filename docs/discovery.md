# Group discovery

`tools/list-groups.mjs` is a tiny relay client that enumerates every
NIP-29 group visible on a relay by subscribing to kind 39000 (group
metadata). Use it to find a group's id when you only know its name.

## Usage

```bash
# Default relay (wss://public.obelisk.ar)
node tools/list-groups.mjs

# Explicit relay
node tools/list-groups.mjs wss://public.obelisk.ar

# Filter by case-insensitive substring of name or about-text
node tools/list-groups.mjs wss://public.obelisk.ar "general"

# Override default 8s timeout
TIMEOUT_MS=20000 node tools/list-groups.mjs wss://public.obelisk.ar
```

Output:

```
[list-groups] querying wss://public.obelisk.ar (timeout 8000ms)…
[list-groups] 9 group(s) on wss://public.obelisk.ar:

  f95bc6138a1fcd68  [open/public]   🎙️ Voice Channel
  26a9cceda473cb1b  [open/public]   💬 General Chat
  4c53c352e854526c  [open/public]   BoyVip
  ...
```

The leading hex is the **group id** — paste into `BOT_GROUPS` (see
[price-bot.md](./price-bot.md)) or any other consumer.

## Visibility caveats

- Some relays only emit kind 39000 to authenticated clients. The script
  doesn't authenticate (no nsec required) and will return an empty list
  on those — run a one-off authenticated query from the bot's nsec or
  from your in-app session to enumerate.
- Filters: this script asks for **all** kind 39000 events. On large
  relays expect a few seconds to drain — bump `TIMEOUT_MS` if results
  feel truncated.
- Newest-wins per group id: if multiple admins re-publish 39000, only
  the most recent is shown.

## Bot-side resolution

If you want the price bot (or any future bot) to look up groups by
*name* instead of id, the same kind 39000 subscription pattern applies:

```js
const sub = pool.subscribe(
  [relay],
  { kinds: [39000] },
  {
    onevent: (ev) => {
      const id = ev.tags.find(t => t[0] === 'd')?.[1];
      const name = ev.tags.find(t => t[0] === 'name')?.[1];
      if (name?.toLowerCase().includes('general')) {
        // join id…
      }
    },
  },
);
```

This is intentionally **not** wired into the price bot's startup —
launching with explicit `relayUrl|groupId` pairs in `BOT_GROUPS` is
deterministic and survives admins renaming a channel. Use the script to
discover the id once, paste it into config, restart.
