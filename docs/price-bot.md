# Price Bot

`bots/price-bot.mjs` — multi-relay, multi-group BTC bot. Publishes BTC
market data as kind:0 metadata (display name = `BTC $123,456`), posts a
kind 9 hello + slash-command listener into each configured group, and
optionally pushes periodic kind 9 price summaries.

## Capabilities

| # | Capability | Event kinds | Notes |
|---|---|---|---|
| 1 | Profile ticker | kind 0 | Published to every URL in `BOT_RELAYS`. The bot's display name updates every time the rounded USD price changes. |
| 2 | Group hello + join-request | kind 9, 9021 | One-shot per group at startup. Open NIP-29 groups auto-admit on 9021; closed groups require an admin kind 9000 add-user. |
| 3 | Slash-command listener | kind 9 | Subscribes to chat in each configured group; replies to `!btc`, `!price`, `!ath`, `!stats`, `!help` with fresh CoinGecko data. |
| 4 | Periodic chat summary | kind 9 | If `BOT_CHAT_EVERY_N_TICKS > 0`, posts a multi-line price/ATH summary to every group every N price-change ticks. |
| 5 | NIP-42 AUTH | kind 22242 | `automaticallyAuth` callback signs challenges with the bot nsec — required by `relay.obelisk.ar`. |
| 6 | Graceful shutdown | — | SIGINT/SIGTERM exits cleanly so PM2 restarts don't leak sockets. |

## Configuration

All via `.env.local` (gitignored, read by PM2 through Node's
`--env-file-if-exists`). Falls back to sensible defaults when unset.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BOT_NSEC` | yes | — | `nsec1...` or 64-char hex. The bot's identity. |
| `BOT_RELAYS` | no | `wss://relay.obelisk.ar` | Comma-separated. Where kind:0 is broadcast. |
| `BOT_GROUPS` | no | empty | Comma-separated `relayUrl|groupId` pairs. The bot joins, listens, and chats in each. |
| `BOT_INTERVAL_MS` | no | `120000` | Price-fetch interval, ms. CoinGecko rate-limits ~10/min for the free tier. |
| `BOT_CHAT_EVERY_N_TICKS` | no | `0` (off) | If >0, post a kind 9 summary every N **price-change** ticks (not wall-clock ticks). |
| `BOT_DISPLAY` | no | `BTC ${price}` | Template for kind:0 `name`. `${price}` interpolated with comma-formatted USD. |
| `BOT_GROUP_ID` | no | — | **Legacy.** Treated as a single group on the first `BOT_RELAYS` entry. Prefer `BOT_GROUPS`. |
| `BOT_STATE_PATH` | no | `state/obelisk-price-bot-state.json` | Override the persisted join/greet state file. |

### Discovering group ids

Use `tools/list-groups.mjs` to enumerate kind 39000 metadata on a relay:

```bash
node tools/list-groups.mjs wss://public.obelisk.ar
node tools/list-groups.mjs wss://public.obelisk.ar "general"   # filter
```

Output is `id [open/closed/public/private] name — about`. Drop the id into
`BOT_GROUPS`.

## Slash commands

The bot listens to kind 9 events with `#h=<groupId>` since startup, looks
for a leading `!cmd`, and replies with a kind 9 tagged with `e` (the
trigger event id) and `p` (the asker's pubkey). Re-deliveries are
deduped by event id.

| Command | Reply |
|---|---|
| `!btc` / `!price` | One-line: `⚡ BTC/USD $123,456 (+1.23% 24h)` |
| `!ath` | One-line: `🏔 ATH $123,456 (-8.45% from ATH, currently $112,900)` |
| `!stats` | Four-line: price, range, ATH, timestamp |
| `!help` | Lists available commands |

Add commands by extending `commandReply()` in the script — keep replies
short to avoid notification spam.

## Running

Direct (foreground, debugging):

```bash
node --env-file-if-exists=.env.local bots/price-bot.mjs
```

PM2 (production, what `obelisk-price-bot` runs):

```bash
npm run pm2:start    # uses ecosystem.config.js — preferred
# or, ad-hoc:
pm2 start bots/price-bot.mjs \
  --name obelisk-price-bot \
  --node-args="--env-file-if-exists=$PWD/.env.local"
pm2 save
```

The bot logs each capability's success/failure on its own line. Healthy
startup looks like:

```
[price-bot] pubkey npub: npub1...
[price-bot] relays:      wss://relay.obelisk.ar, wss://public.obelisk.ar
[price-bot] groups:      wss://relay.obelisk.ar|dab35d..., wss://public.obelisk.ar|26a9cc...
[price-bot] join-request sent: wss://public.obelisk.ar 26a9cced
[price-bot] hello sent: wss://public.obelisk.ar 26a9cced
[price-bot] kind:0 → BTC 78,587 (+0.06% 24h)
```

## Verifying

```bash
pm2 logs obelisk-price-bot --lines 50
```

For the live group view, open
`https://obelisk.ar/app?c=<groupId>` and look for the bot in the member
list (display name is the live BTC price). Send `!btc` in chat to
sanity-check the command listener.

## Why it might not show up

1. **Relay rejected publishes** (`All promises were rejected` on every
   line) — npub not whitelisted on the relay, or AUTH failed. Confirm
   you whitelisted the npub printed at startup.
2. **Bot in chat but not in member list** — for closed groups, ask an
   admin to issue kind 9000 add-user. Open NIP-29 groups should
   auto-admit on the bot's 9021 join-request, but some relay
   implementations defer this until the next 39002 republish.
3. **Profile not resolving** — kind:0 only goes to `BOT_RELAYS`. If you
   want the bot's profile to render in clients connected to other
   relays (damus, primal, nostr.band), add those to `BOT_RELAYS`.

## Stopping / rotating

```bash
pm2 stop obelisk-price-bot
pm2 delete obelisk-price-bot
pm2 save
```

Rotate the nsec: stop the bot, generate a new nsec, update `.env.local`,
re-whitelist on each relay, restart. If the bot was admin-added by kind
9000, you'll need a fresh 9000 add-user with the new pubkey (and
optionally 9001 remove-user with the old one) signed by a human admin.
