# Managing bots

Operational guide to creating, configuring, running, and updating bots
in this repo. For the agent-oriented cheat sheet, see
[AGENT.md](../AGENT.md).

## Creating a new bot

`tools/new-bot.mjs` generates a fresh nsec and writes a starter
`bots/<name>.mjs` with a working scaffold (subscribes to chat in each
configured group, replies `pong` to `!ping`).

```bash
npm run new-bot -- welcome-bot
```

Output prints **nsec, npub, and hex pubkey**. The script never writes
the nsec to disk — you copy it into `.env.local` yourself, e.g.:

```
WELCOME_BOT_NSEC=nsec1...
WELCOME_BOT_GROUPS=wss://relay.obelisk.ar|<groupId>
WELCOME_BOT_RELAYS=wss://relay.obelisk.ar
```

Convention: per-bot env vars use the bot name in `SCREAMING_SNAKE`
(`WELCOME_BOT_NSEC`, `MOD_BOT_GROUPS`). The scaffold falls back to the
shared `BOT_*` defaults if no per-bot vars are set, so the simplest
case is "single bot, BOT_NSEC only".

After scaffolding, edit `bots/<name>.mjs` to implement your behavior
and add a PM2 entry.

## Adding a PM2 entry

Open `ecosystem.config.js` and copy the `obelisk-price-bot` stanza:

```js
{
  name: 'obelisk-welcome-bot',
  script: 'bots/welcome-bot.mjs',
  cwd,
  node_args: nodeArgs,   // already set above
  watch: false,
  autorestart: true,
}
```

Then:

```bash
npm run pm2:start    # starts everything in ecosystem.config.js + pm2 save
```

PM2 reads `--env-file-if-exists=.env.local` via `node_args`, so secrets
do not need to be passed on the command line.

## Editing a bot's profile (name / picture / about)

`tools/set-profile.mjs` publishes a kind:0 event for the bot's nsec.
This is what other Nostr clients (Damus, Amethyst, Obelisk itself) read
when they show the bot's display name and avatar.

```bash
PROFILE_NAME="WelcomeBot" \
PROFILE_DISPLAY="Welcome Bot" \
PROFILE_ABOUT="Greets new members and links the rules." \
PROFILE_PICTURE="https://example.com/welcome.png" \
PROFILE_NIP05="welcome@obelisk.ar" \
PROFILE_LUD16="welcome@getalby.com" \
  npm run set-profile
```

Defaults to the `BOT_NSEC` identity. To target a different bot:

```bash
npm run set-profile -- --nsec-env=WELCOME_BOT_NSEC
```

Default relays: `BOT_RELAYS` if set, else
`relay.obelisk.ar + damus + nostr.band + nos.lol + primal + purplepag.es`.
Set `BOT_RELAYS` if your bot's profile should be visible globally.

To clear a field, set it to an empty string in stdin JSON:

```bash
echo '{"about":""}' | npm run set-profile
```

(Empty env vars are skipped; only stdin JSON can blank an existing
field.)

## Granting permissions in a group

NIP-29 grants permission via **kind 9000** with role tags. Roles are
free-form strings agreed between admins and the relay; the convention on
`relay.obelisk.ar` is:

| Role | Powers |
|---|---|
| `admin` | full — kinds 9000–9007 |
| `mod`   | remove + delete (kinds 9001, 9003) |
| (none)  | plain member — can read/write kind 9, kicked by admins |

`tools/grant-admin.mjs` publishes the kind 9000 from a *human admin's*
nsec — you cannot promote a bot using its own keys.

```bash
ADMIN_NSEC=<your-admin-nsec> \
TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
TARGET_PUBKEY=<bot npub or hex> \
TARGET_ROLES=admin,welcomer \
  npm run grant-admin
```

For a plain member (no special role): `npm run add-member` (same env
vars, no `TARGET_ROLES`).

To remove: rerun `grant-admin` with `--remove` — emits kind 9001
`remove-user`.

The relay emits a fresh kind 39001 listing within seconds. The bot's
admin events will be accepted from that point on.

## Discovering group ids

`tools/list-groups.mjs` enumerates kind 39000 group metadata on a
relay:

```bash
npm run list-groups                                 # default relay
npm run list-groups -- wss://public.obelisk.ar      # explicit
npm run list-groups -- wss://public.obelisk.ar "ge" # filter by name/about
```

Caveats:
- Some relays only emit kind 39000 to authenticated clients. This script
  doesn't authenticate — run from a session that does, or whitelist
  read access.
- `TIMEOUT_MS=20000 npm run list-groups -- …` if results feel
  truncated on a busy relay.

## Updating a bot's behavior

Just edit `bots/<name>.mjs` and:

```bash
pm2 restart obelisk-<name>
pm2 logs obelisk-<name> --lines 50
```

For the price-bot specifically, the persisted state file
(`state/obelisk-price-bot-state.json` by default, or `BOT_STATE_PATH`)
tracks which groups have already received hellos. Delete it to force a
re-greet on next restart, or run `npm run price-bot:cleanup` to issue
NIP-09 deletions for previous hellos before re-greeting.

## Rotating a bot's nsec

1. `pm2 stop obelisk-<name>`
2. Generate new nsec with `npm run new-bot -- <name>-v2` (or by hand)
3. **As human admin**: `npm run grant-admin` to add the new pubkey,
   then `npm run grant-admin -- --remove` for the old one.
4. Whitelist new npub on each relay if applicable.
5. Update `.env.local` with the new nsec.
6. `pm2 restart obelisk-<name>`.

Don't run a single-admin group with only the bot as admin unless the
nsec is stored somewhere recoverable — losing it makes the group
ungovernable.

## Stopping / decommissioning

```bash
pm2 stop obelisk-<name>
pm2 delete obelisk-<name>
pm2 save
```

Then remove the entry from `ecosystem.config.js` and (optionally) the
bot file under `bots/`. The bot's nsec stays valid forever — if you
truly want it gone, also remove it from groups via kind 9001
(`grant-admin --remove`).
