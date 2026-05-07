# Obelisk Bots

Nostr bots for the Obelisk ecosystem (NIP-29 groups). Each bot is a small
Node process that holds its own `nsec`, talks directly to relays, and
publishes events. There is **no backend** — bots are plain Nostr clients
supervised by PM2.

> Looking for the chat app? It lives at [obelisk-app/obelisk](https://github.com/obelisk-app/obelisk).
> Looking for the relay? [obelisk-app/obelisk-relay](https://github.com/obelisk-app/obelisk-relay).

## What's in here

```
bots/                 one .mjs file per long-running bot
  price-bot.mjs           BTC ticker (publishes kind:0, replies to !btc / !ath / ...)
  price-bot.cleanup.mjs   one-shot cleanup of duplicate startup hellos
tools/                management utilities you run by hand or from a coding agent
  new-bot.mjs             scaffold a new bot + generate its nsec
  whoami.mjs              decode an nsec env var → npub
  set-profile.mjs         publish kind:0 (edit a bot's display name / picture / about)
  grant-admin.mjs         publish kind 9000 to add a pubkey as admin (or any role)
  add-member.mjs          publish kind 9000 to add a pubkey as plain member
  list-groups.mjs         enumerate kind 39000 group metadata on a relay
lib/                  shared helpers (parseSecret, createPool with NIP-42 auth)
ecosystem.config.js   PM2 process list — one entry per bot
.env.example          copy to .env.local and fill in
docs/                 design notes (taxonomy, admin-bot pattern, discovery)
```

## Install

```bash
git clone https://github.com/obelisk-app/obelisk-bots.git
cd obelisk-bots
npm install
cp .env.example .env.local   # then fill in BOT_NSEC etc.
```

Node 20+ required. The npm scripts pass `--env-file-if-exists=.env.local`
automatically — no `dotenv` dependency.

## Quickstart: run the price bot

1. Generate a nsec for the bot:
   ```bash
   npm run new-bot -- price-bot   # or use an existing nsec
   ```
   (Skip if you already have a `BOT_NSEC` in `.env.local`.)

2. Whitelist the printed npub on `wss://relay.obelisk.ar` if it enforces
   an allow-list.

3. Add the bot to one or more groups (run as a *human* admin):
   ```bash
   ADMIN_NSEC=<your-admin-nsec> \
   TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
   TARGET_PUBKEY=<bot-npub> \
     npm run add-member
   ```

4. Set `BOT_GROUPS` in `.env.local`:
   ```
   BOT_GROUPS=wss://relay.obelisk.ar|<groupId>
   ```

5. Start under PM2:
   ```bash
   npm run pm2:start
   pm2 logs obelisk-price-bot
   ```

## Bot taxonomy

| Type | Identity | Privileges needed | Examples |
|---|---|---|---|
| Profile bot | own nsec | none — publishes own kind:0 | price-bot (BTC ticker as display name) |
| Group member bot | own nsec | admitted via kind 9000 | price-bot when posting kind 9 / showing in member list |
| Admin bot | nsec with admin role | listed in kind 39001 | welcome-bot, role-assigner, content-mod |
| Relay-operator bot | nsec on relay allow-list | relay-side write permission | any bot publishing to a closed relay |

A single bot can wear multiple hats (price-bot is a profile bot first; once
admin adds it to a group it's also a member bot).

## Conventions

- **Language**: Node ESM. Plain `.mjs` under `bots/`. No build step.
- **Nostr lib**: `nostr-tools` (`SimplePool`, `finalizeEvent`, `nip19`,
  `getPublicKey`). Bots do **not** use NDK.
- **WebSocket**: `useWebSocketImplementation(WebSocket)` from
  `nostr-tools/pool` plus the `ws` package — Node has no native WebSocket.
- **Identity**: bots own their nsec. Never reuse a human's nsec for a bot.
- **Secrets**: live in `.env.local` (gitignored, mode 600 recommended).
- **Supervisor**: PM2. Each bot is its own process so it can be restarted,
  logged, and monitored independently.
- **Default relay**: `wss://relay.obelisk.ar`. Add public relays to
  `BOT_RELAYS` only when the bot's profile (kind:0) needs to be globally
  visible.
- **Filters as struct, not array**: relay29-derived relays reject
  multi-filter REQs. Use `pool.subscribe(relays, singleFilter, params)`,
  not `subscribeMany`.

## Operations

| Task | Command |
|---|---|
| Start every bot in `ecosystem.config.js` | `npm run pm2:start` |
| Restart all bots | `npm run pm2:restart` |
| Tail logs | `npm run pm2:logs` |
| Restart one bot | `pm2 restart obelisk-price-bot` |
| Clean up duplicate hello messages | `npm run price-bot:cleanup` |
| Decode an nsec → npub | `npm run whoami -- BOT_NSEC` |
| Discover group ids | `npm run list-groups -- wss://relay.obelisk.ar` |

## Security notes

- Bot nsecs are functionally root for that identity. Treat `.env.local`
  like a credential store.
- An admin bot can ban members, rename the group, change images. Scope
  its capabilities by the events it actually emits — don't grant the
  admin role unless the bot needs kind 9000–9007 powers.
- Bots run server-side and can read plaintext `BOT_NSEC`. Anyone with
  shell access to this host can impersonate them. Rotate the nsec if you
  suspect compromise (and re-issue the kind 9000 add-user with the new
  pubkey).

## See also

- [AGENT.md](./AGENT.md) — cheat sheet for coding terminal agents (Claude
  Code, Codex, Cursor) to drive this repo.
- [docs/managing-bots.md](./docs/managing-bots.md) — full guide to
  creating, configuring, and managing bots from the CLI.
- [docs/admin-bot.md](./docs/admin-bot.md) — design pattern for admin /
  moderation bots.
- [docs/discovery.md](./docs/discovery.md) — how to enumerate groups on a
  relay.
