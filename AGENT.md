# AGENT.md — Obelisk Bots

Cheat sheet for coding terminal agents (Claude Code, Codex, Cursor, …)
that need to create, configure, run, or manage bots in this repo.
Designed so an agent can drive the whole lifecycle without ever opening
a browser.

## Mental model

A bot is **one `.mjs` file under `bots/`** plus **one entry in
`ecosystem.config.js`** plus **one `*_NSEC` line in `.env.local`**.
That's the whole surface. Everything else (PM2 supervision, NIP-42 AUTH,
relay reconnect) is shared via `lib/`.

Three actor types are involved:

| Actor | What it holds | Drives |
|---|---|---|
| **The bot** | its own nsec (`BOT_NSEC`, `WELCOME_BOT_NSEC`, …) | publishes the bot's own events |
| **The human admin** | their personal nsec (passed as `ADMIN_NSEC` only when running grant tools) | grants the bot membership/admin roles in a group |
| **The agent** (you) | shell access, edits files, runs npm scripts | scaffolds, starts, stops, edits metadata |

The agent never holds an nsec — it reads them from `.env.local` and
passes them through Node.

## Lifecycle: creating and shipping a new bot

```
1. npm run new-bot -- <name>             # generates nsec + bots/<name>.mjs
2. add  <NAME>_NSEC=<nsec>  to .env.local
3. add  PM2 entry to ecosystem.config.js (copy the price-bot stanza)
4. (one-time, as human admin) npm run grant-admin   # or add-member
5. npm run set-profile                   # publish kind:0 metadata
6. npm run pm2:start
7. pm2 logs obelisk-<name>               # verify
```

You can do steps 1–3 entirely from an agent. Steps 4–5 require an
`ADMIN_NSEC` (human admin's key) on the command for that single
invocation.

## Common operations

### Edit a bot's display name / picture / about (kind:0)

```bash
PROFILE_NAME="WelcomeBot" \
PROFILE_DISPLAY="Welcome Bot" \
PROFILE_ABOUT="Greets new members and links the rules." \
PROFILE_PICTURE="https://example.com/avatar.png" \
  npm run set-profile
```

To target a specific bot (when you have multiple in `.env.local`), pass
`--nsec-env=NAME`:

```bash
npm run set-profile -- --nsec-env=WELCOME_BOT_NSEC
```

To clear a field, omit it from the env. To overwrite with empty string,
pipe JSON on stdin: `echo '{"about":""}' | npm run set-profile`.

### Make a bot an admin of a group

```bash
ADMIN_NSEC=<your personal admin nsec> \
TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
TARGET_PUBKEY=<bot npub or hex> \
TARGET_ROLES=admin \
  npm run grant-admin
```

`TARGET_ROLES` is comma-separated (`admin,welcomer`). Drop or empty it
to add as plain member (or use `npm run add-member`).

To remove: same command with `--remove`:

```bash
ADMIN_NSEC=… TARGET_GROUP=… TARGET_PUBKEY=… npm run grant-admin -- --remove
```

### Discover a group id from a name

```bash
npm run list-groups -- wss://relay.obelisk.ar "general"
```

Output is `<id>  [open|closed/public|private]  <name>`. Drop the id into
`BOT_GROUPS` (price-bot) or pass via `TARGET_GROUP` to admin tools.

### Run a one-off command in chat as a bot

The `tools/` directory only covers the common cases. For arbitrary
publishes, use the bot's libs directly:

```bash
node --env-file-if-exists=.env.local --input-type=module -e '
  import("nostr-tools").then(async ({ finalizeEvent }) => {
    const { identityFromEnv } = await import("./lib/secret.mjs");
    const { createPool } = await import("./lib/pool.mjs");
    const { sk } = identityFromEnv("BOT_NSEC");
    const pool = createPool(sk);
    const ev = finalizeEvent({
      kind: 9,
      created_at: Math.floor(Date.now()/1000),
      tags: [["h", "<groupId>"]],
      content: "ad-hoc message",
    }, sk);
    await Promise.any(pool.publish(["wss://relay.obelisk.ar"], ev));
    process.exit(0);
  });
'
```

Or write a one-off script under `tools/` and invoke it via npm.

## Reading runtime state

```bash
pm2 list                               # all bots, status, uptime, restarts
pm2 logs obelisk-price-bot --lines 50  # recent stdout
pm2 describe obelisk-price-bot         # cwd, script path, env, log paths
pm2 monit                              # live process monitor (interactive)
```

Bots store join/greeted state under the repo-local `state/` directory by
default, for example `state/obelisk-price-bot-state.json`. Set
`OBELISK_BOTS_STATE_DIR` or a per-bot `*_STATE_PATH` override to move it.
Delete the relevant state file if you want a clean re-greet (then expect
one hello per group on next start).

## Rules of thumb for agents

1. **Never invent an nsec.** Use `npm run new-bot` or read from
   `.env.local`. Don't paste private keys into the conversation.
2. **`.env.local` is gitignored.** Adding a secret to it is safe.
   Adding a secret to a tracked file is not — `git status` should be
   clean of any file with `nsec1...` in it before you commit.
3. **One bot, one nsec, one PM2 entry.** Don't multiplex bots in a
   single Node process — PM2 restarts the whole process on crash.
4. **Test before PM2.** Run a new bot foreground first
   (`node --env-file-if-exists=.env.local bots/<name>.mjs`) and watch
   for a clean `[<name>] running as npub…` line. Add to PM2 only after
   it stabilizes.
5. **Idempotency.** Relays re-deliver on reconnect. Track event ids
   you've reacted to; never act blindly on every onevent.
6. **Use the existing helpers.** `lib/secret.mjs` and `lib/pool.mjs`
   are the canonical way to load identity and open relays — don't
   re-implement parseSecret or auto-AUTH per bot.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `All promises were rejected` on every publish | npub not whitelisted on the relay, or NIP-42 AUTH failed (rare — pool auto-auths). |
| Bot publishes but isn't visible in member list | Closed group; ask a human admin to run `npm run add-member` for the bot's npub. |
| `coingecko 429` (price-bot) | Rate limit. Increase `BOT_INTERVAL_MS`. |
| Bot duplicates messages on restart | Add an in-memory `Set` of event ids you've replied to; price-bot already does this. |
| Profile not resolving in damus / primal | kind:0 only went to `BOT_RELAYS`. Add public relays and re-run `npm run set-profile`. |
| `Invalid message format: invalid type: sequence, expected struct Filter` | You used `pool.subscribeMany` — switch to `pool.subscribe` with a single filter. |

## What this repo intentionally does NOT do

- **No web UI.** Management is CLI-only. If you want a dashboard,
  point a separate tool at `pm2 jlist` JSON output.
- **No persistent message store.** Bots are stateless except for the
  small JSON files they write to the ignored `state/` directory, or to a
  configured state path.
- **No relay-side enforcement.** Whitelisting, role checks, and rate
  limits live on the relay (see
  [obelisk-app/obelisk-relay](https://github.com/obelisk-app/obelisk-relay)).
  This repo only publishes events; it cannot enforce who else can.
