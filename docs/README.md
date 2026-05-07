# Obelisk Bots

Obelisk has no backend — bots are plain Nostr clients that hold an nsec, talk
directly to `wss://relay.obelisk.ar`, and publish events. They are processes,
not platform features. Each bot is a single Node script under `bots/` and a
PM2 entry that keeps it running.

## Bot taxonomy

| Type | Identity | Privileges needed | Examples |
|---|---|---|---|
| **Profile bot** | own nsec | none — publishes own kind:0 | [price-bot](./price-bot.md) (BTC ticker as display name) |
| **Group member bot** | own nsec | admitted to group via kind 9000 | [price-bot](./price-bot.md) when posting kind 9 / showing in member list |
| **Admin bot** | nsec with admin role in target group | listed in kind 39001 (admins) | [admin-bot](./admin-bot.md) (auto-moderation, welcome flow, role assignment) |
| **Relay-operator bot** | nsec whitelisted by relay | relay-side allow-list / write permission | any bot that publishes to a closed relay |

A single bot can wear multiple hats. Price bot is a profile bot first; once an
admin adds it to a group it's also a member bot. An admin bot is a member bot
with the admin role attached on top.

## Stack & conventions

- **Language**: Node ESM, no TypeScript build step. Plain `.mjs` under `bots/`.
- **Nostr lib**: `nostr-tools` (`SimplePool`, `finalizeEvent`, `nip19`,
  `getPublicKey`). Bots do **not** use NDK or the in-app bridge.
- **WebSocket**: `useWebSocketImplementation(WebSocket)` from `nostr-tools/pool`
  with the `ws` package — Node has no native `WebSocket`.
- **Identity**: bots own their nsec. Never reuse a human's nsec for a bot.
- **Secrets**: live in `.env.local` (gitignored). PM2 reads them via Node's
  `--env-file-if-exists` flag, set as `node_args` in the PM2 entry.
- **Supervisor**: PM2. Each bot is its own PM2 process so it can be restarted,
  logged, and monitored independently of the Next.js app.
- **Relay**: `wss://relay.obelisk.ar` for all group/chat events. Public relays
  (damus, nostr.band, primal) are appropriate when you specifically want the
  bot's profile to be globally discoverable.

## File layout

```
bots/
├── price-bot.mjs           # BTC ticker bot
├── price-bot.cleanup.mjs   # one-shot cleanup utility for price-bot
└── <your-bot>.mjs          # one file per bot (scaffold via `npm run new-bot`)

tools/
├── new-bot.mjs             # scaffold new bot + generate nsec
├── set-profile.mjs         # publish kind:0 metadata
├── grant-admin.mjs         # add a pubkey as admin (kind 9000)
├── add-member.mjs          # add a pubkey as plain member (kind 9000)
├── list-groups.mjs         # discovery (see ./discovery.md)
└── whoami.mjs              # decode nsec → npub

lib/
├── secret.mjs              # parseSecret, identityFromEnv, newIdentity
└── pool.mjs                # SimplePool factory with NIP-42 auto-AUTH

docs/
├── README.md               # this file — taxonomy, lifecycle, conventions
├── price-bot.md            # operational guide for the price bot
├── admin-bot.md            # design pattern for admin/moderation bots
├── discovery.md            # how to enumerate groups on a relay
└── managing-bots.md        # full guide to creating, configuring, managing bots

ecosystem.config.js         # PM2 process list — one entry per bot
.env.local                  # secrets (gitignored): BOT_NSEC, BOT_GROUPS, ...
```

## Lifecycle: spinning up a new bot

1. **Generate the bot and nsec.**
   ```bash
   npm run new-bot -- welcome-bot
   ```
   Prints nsec/npub/hex pubkey and writes a starter `bots/welcome-bot.mjs`.

2. **Save the secret to `.env.local`.** Use a per-bot var
   (`WELCOME_BOT_NSEC`) so multiple bots can run side-by-side, or share
   `BOT_NSEC` if there's only one.

3. **Whitelist the npub on the relay** if `relay.obelisk.ar` enforces an
   allow-list (it currently does — unsigned/unauth posts are rejected).

4. **Add the bot to the target group** as a human group admin:
   ```bash
   ADMIN_NSEC=<your admin nsec> \
   TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
   TARGET_PUBKEY=<bot npub> \
   TARGET_ROLES=admin \
     npm run grant-admin
   ```
   Drop `TARGET_ROLES` (or use `npm run add-member`) for plain
   membership. Until this happens the bot's kind 9 / kind 9005 events
   will be silently dropped by NIP-29 relays.

5. **Set kind:0 metadata** so the bot has a name & avatar:
   ```bash
   PROFILE_NAME="Welcome" PROFILE_DISPLAY="Welcome Bot" \
   PROFILE_ABOUT="Greets new members." \
     npm run set-profile -- --nsec-env=WELCOME_BOT_NSEC
   ```

6. **Register with PM2** by adding a stanza to `ecosystem.config.js`,
   then:
   ```bash
   npm run pm2:start
   ```

7. **Verify**: `pm2 logs obelisk-welcome-bot` — the bot logs its own
   npub at startup; sanity-check it matches what you whitelisted/admitted.

## NIP-01 quirk: filters as struct, not array

The Obelisk relays (and other relay29-derived relays) reject
multi-filter REQs sent by `pool.subscribeMany`:

```
NOTICE: Invalid message format: invalid type: sequence, expected struct Filter
```

Always use `pool.subscribe(relays, singleFilter, params)` for relay29
hosts. `subscribeMany` works on strfry/khatru and is fine for general
Nostr relays — but in this repo, default to `subscribe`. The bridge
already does this; new bots should follow the same pattern.

## Failure modes

- **`All promises were rejected`** on every publish: the relay rejected the
  event. Almost always one of (a) bot not whitelisted on the relay, (b) bot
  not yet admitted to the group, (c) NIP-42 AUTH failed. All bots in this
  repo auto-AUTH via `lib/pool.mjs` (`createPool(sk)` returns a SimplePool
  with `automaticallyAuth` wired up); if you bypass it, you'll need to
  reimplement AUTH yourself.
- **`coingecko 429`** in price bot: rate-limited. Increase `BOT_INTERVAL_MS`.
- **Bot keeps publishing duplicate events**: the price bot dedupes via
  `lastPrice`. If you fork it, keep that pattern — relays accept duplicates
  but clients render churn.
- **Bot's profile not discoverable globally**: kind:0 published only to
  `relay.obelisk.ar`. Add public relays to the publish list if external
  visibility matters.

## Security notes

- Bot nsecs are functionally root for that identity. Treat `.env.local` like
  a credential store: file mode 600, never committed, never logged.
- An admin bot can ban members, rename the group, change images. Scope its
  capabilities by the events it actually emits — don't grant admin role
  unless the bot needs kind 9000–9007 powers.
- Bots run server-side and can see plaintext `BOT_NSEC`. Anyone with shell
  access to this host can impersonate them. Rotate the nsec if you suspect
  compromise (and re-issue the kind 9000 add-user with the new pubkey).
