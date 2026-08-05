# Building a bot — the complete guide

Written for **coding agents** (Codex, Claude Code, Cursor, the Operator
page on bots.obelisk.ar) and humans alike. Follow it top to bottom and
you will ship a working, supervised, discoverable Nostr bot without
opening a browser.

A bot in this repo is exactly three things:

1. **one file** — `bots/<name>.mjs`
2. **one identity** — `<NAME>_NSEC=` line in `.env.local` (gitignored)
3. **one supervisor entry** — a stanza in `ecosystem.config.cjs`

Everything else (relay pools, NIP-42 AUTH, state files, group parsing)
is shared code under `lib/`. Never re-implement it.

---

## 1. The 10-minute lifecycle

```bash
# 1. scaffold: generates an nsec + bots/<name>.mjs template
npm run new-bot -- welcome-bot
#    → prints npub + nsec. Copy the nsec into .env.local:
#      WELCOME_BOT_NSEC=nsec1...
#    (The manager UI / API does steps 1–2 in one click and never
#     shows the nsec.)

# 2. edit bots/welcome-bot.mjs — see §3 for the communication patterns

# 3. test foreground FIRST. You want a clean startup line:
node --env-file-if-exists=.env.local bots/welcome-bot.mjs
#    → "[welcome-bot] running as npub1..."   Ctrl-C when satisfied.

# 4. register with PM2: copy the price-bot stanza in
#    ecosystem.config.cjs, change name + script. Then:
npm run pm2:start
pm2 logs obelisk-welcome-bot --lines 20

# 5. give it a face (kind 0 profile):
PROFILE_NAME="WelcomeBot" PROFILE_ABOUT="Greets newcomers" \
  npm run set-profile -- --nsec-env=WELCOME_BOT_NSEC

# 6. (human admin, once) admit the bot into groups:
ADMIN_NSEC=<admin nsec> TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
TARGET_PUBKEY=<bot npub> npm run add-member
```

Checklist before you call it done:

- [ ] foreground run prints its npub and stays alive 60s without errors
- [ ] the bot's npub is whitelisted on every closed relay it writes to
- [ ] `pm2 logs` shows no reconnect loop
- [ ] state (if any) goes through `lib/state.mjs`, never ad-hoc files
- [ ] no secret ever appears in a tracked file (`git status` is clean)

## 2. Environment variables — the contract

The manager UI builds each bot's settings form by scanning its source
for `process.env.X`, so **read config only via `process.env`** with the
bot's own prefix and a `BOT_*` fallback:

```js
const RELAYS = (process.env.WELCOME_BOT_RELAYS || process.env.BOT_RELAYS
  || 'wss://relay.obelisk.ar').split(',').map(s => s.trim()).filter(Boolean);
```

Conventions:

| Var | Meaning | Format |
|---|---|---|
| `<NAME>_NSEC` | bot identity | `nsec1…` (secret — never log it) |
| `<NAME>_RELAYS` | relays to write to | comma-separated `wss://…` |
| `<NAME>_GROUPS` | NIP-29 groups to serve | comma-separated `wss://relay\|groupId` |
| `<NAME>_*_MS` | any interval | milliseconds |

Parse group lists with `parseGroupList()` from `lib/pool.mjs`.

## 3. Nostr communication — how bots talk

### Identity and connection (always the same two lines)

```js
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';

const { sk, pk, npub } = identityFromEnv('WELCOME_BOT_NSEC');
const pool = createPool(sk);   // SimplePool with automatic NIP-42 AUTH
console.log(`[welcome-bot] running as ${npub}`);
```

`createPool(sk)` answers relay AUTH challenges automatically — closed
relays (like relay.obelisk.ar) demand it before accepting REQ or EVENT.

### Reading (subscriptions)

```js
const sub = pool.subscribe(RELAYS, {
  kinds: [9],                                  // chat messages
  '#h': [groupId],                             // this group only
  since: Math.floor(Date.now() / 1000) - 10,   // don't replay history
}, {
  onevent(ev) { /* react */ },
  oneose() { /* initial sync done */ },
});
```

**Rules that will save you an afternoon:**

- **One filter per subscription.** relay29-derived relays reject
  multi-filter REQs (`invalid type: sequence, expected struct Filter`).
  Use `pool.subscribe(relays, singleFilter, params)` — never
  `subscribeMany`, never an array of filters. Need two filters? Open two
  subscriptions.
- **Idempotency.** Relays re-deliver on reconnect. Keep a `Set` (or an
  LRU) of processed event ids and skip repeats:
  ```js
  const seen = new Set();
  if (seen.has(ev.id)) return;
  seen.add(ev.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  ```
- **Ignore your own events**: `if (ev.pubkey === pk) return;`
- **Use `since`** so a restart doesn't reprocess the whole group history.

### Writing (publishing)

```js
import { finalizeEvent } from 'nostr-tools';

const ev = finalizeEvent({
  kind: 9,                                   // NIP-29 group chat message
  created_at: Math.floor(Date.now() / 1000),
  tags: [['h', groupId]],                    // REQUIRED for group events
  content: 'hello!',
}, sk);
await Promise.any(pool.publish(RELAYS, ev)); // any one OK is success
```

`Promise.any` because closed relays reject writes from non-whitelisted
keys — one acceptance is enough. If **all** relays reject, the usual
causes are: npub not whitelisted, bot not a group member, missing `h`
tag.

### The NIP-29 kind cheat-sheet

| Kind | What | Bot needs |
|---|---|---|
| `9` | group chat message | membership (closed groups) |
| `0` | profile metadata (name/picture/about) | nothing — it's your own |
| `39000` | group metadata (name, access) | read-only discovery |
| `39001/39002` | group admins / members lists | read-only |
| `9000`–`9007` | admin ops (add/remove user, edit metadata…) | **admin role** |
| `9021` | join request | nothing |
| `9735` | zap receipt (NIP-57) | read-only (see zap-bot) |

Replaceable kinds (`0`, `39xxx`): relays keep only the newest per
(pubkey, kind, d-tag) — re-publishing is how you edit.

### Mentions and replies (kind 9 content)

- Mention a user: put `nostr:npub1…` in `content` — Obelisk clients
  render it as a profile link (see `bots/zap-bot.mjs` for npub encoding).
- Reply to a message: add `['e', parentEventId]` alongside the `h` tag.

### Dynamic group discovery

Serving *every* group on a relay instead of a fixed list? Reuse
`lib/group-watcher.mjs` — it subscribes to kind `39000`, keeps a live
map of groups, and calls you back on join/leave. zap-bot is the
reference integration.

### Command bots (replying to !commands)

Pattern from price-bot / sat-ars-bot:

```js
const COMMANDS = { '!btc': () => fmtPrice(), '!help': () => HELP_TEXT };
// in onevent for kind 9:
const word = ev.content.trim().split(/\s+/)[0].toLowerCase();
const handler = COMMANDS[word];
if (handler) publishTo(groupOf(ev), await handler());
```

Throttle: never answer the same command twice within a few seconds
(spam-loop protection when two bots answer each other).

## 4. State that survives restarts

```js
import { createStateStore } from '../lib/state.mjs';
const store = createStateStore({
  fileName: 'obelisk-welcome-bot-state.json',
  envName: 'WELCOME_BOT_STATE_PATH',
  logPrefix: 'welcome-bot',
});
const state = store.loadState();   // {} on first run
state.greeted = [...(state.greeted ?? []), ev.pubkey];
store.saveState(state);
```

PM2 runs bots with `OBELISK_BOTS_STATE_DIR=/var/lib/obelisk-bots/state`;
foreground runs fall back to the repo-local `state/` dir. Both are
outside git.

## 5. Operating an existing bot (agent quick-ref)

| I want to… | Do |
|---|---|
| see all bots + status | `pm2 list` or `GET /api/bots` on the manager |
| restart after config change | `pm2 restart obelisk-<name>` |
| change relays/groups/settings | edit `.env.local`, restart the bot (or use the manager UI) |
| read logs | `pm2 logs obelisk-<name> --lines 50` |
| change display name / about | `npm run set-profile -- --nsec-env=<NAME>_NSEC` (env or stdin JSON) |
| upload an avatar picture | manager UI → bot → Profile → Upload: the server signs a Blossom upload (kind 24242) with the bot key and publishes the merged kind 0 |
| find a group id | `npm run list-groups -- wss://relay.obelisk.ar "name"` |
| check what a relay stored | `tools/show-profile.mjs`, `tools/inspect-events.mjs` |
| test a zap end-to-end | `tools/simulate-zap.mjs` |

## 6. Hard rules

1. **Never invent, print, or commit an nsec.** `npm run new-bot`
   generates; `.env.local` stores; `identityFromEnv()` reads.
2. **One bot, one process.** Don't multiplex bots in one file.
3. **Test foreground before PM2.**
4. **Reuse `lib/`.** If you're writing WebSocket or AUTH code in a bot
   file, stop — it exists in `lib/pool.mjs`.
5. **A bot only publishes kinds it's documented to publish.** Admin
   kinds (9000+) require an explicit human decision to grant the role.
