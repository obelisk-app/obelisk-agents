# Sat/ARS Bot

`bots/sat-ars-bot.mjs` — publishes the satoshi-to-Argentine-peso price as
kind:0 metadata and answers slash-commands in NIP-29 groups. Mirrors
[price-bot](./price-bot.md) but uses [yadio.io](https://yadio.io) (Argentine
BTC rate aggregator) instead of CoinGecko.

## Why

At ~80k USD per BTC and ~1,500 ARS per USD, **1 sat ≈ 1.20 ARS**. That's
the most legible Bitcoin price unit for Argentine users right now — sats
are roughly 1:1 with pesos.

## Capabilities

| # | Capability | Event kinds | Notes |
|---|---|---|---|
| 1 | Profile ticker | kind 0 | display name = `sat 1.20 ARS`, refreshed when the rounded value changes. |
| 2 | Group hello + join-request | kind 9, 9021 | One-shot per group at startup. |
| 3 | Slash-command listener | kind 9 | replies to `!sat`, `!btc`, `!ars`, `!stats`, `!help`. |
| 4 | Periodic chat summary | kind 9 | optional, gated on `SAT_ARS_BOT_CHAT_EVERY_N_TICKS > 0`. |
| 5 | NIP-42 AUTH | kind 22242 | auto-AUTH via `lib/pool.mjs`. |

## Configuration

Per-bot env vars take precedence; `BOT_*` shared vars are fallback only.
**Use a separate nsec from price-bot** — both bots publish kind:0, so
sharing an identity makes them fight over it.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SAT_ARS_BOT_NSEC` | yes | — | nsec1... or 64-char hex. |
| `SAT_ARS_BOT_RELAYS` | no | `BOT_RELAYS` or `wss://relay.obelisk.ar` | comma-separated. |
| `SAT_ARS_BOT_GROUPS` | no | `BOT_GROUPS` or empty | `relayUrl|groupId` pairs. |
| `SAT_ARS_BOT_INTERVAL_MS` | no | `60000` | yadio refreshes ~every 60s; don't go lower. |
| `SAT_ARS_BOT_DISPLAY` | no | `sat ${price} ARS` | template; `${price}` = ARS per sat to 2 decimals. |
| `SAT_ARS_BOT_CHAT_EVERY_N_TICKS` | no | `0` (off) | post a kind 9 summary every N price-change ticks. |
| `SAT_ARS_BOT_STATE_PATH` | no | `state/obelisk-sat-ars-bot-state.json` | Override the persisted join/greet state file. |

## Slash commands

| Command | Reply |
|---|---|
| `!sat` / `!sats` | `⚡ 1 sat = 1.20 ARS · 1k = 1.200 ARS · 10k = 12.000 ARS` |
| `!btc` | `₿ BTC $80,000 USD ≈ 119M ARS` |
| `!ars` / `!usd` / `!usdars` | `💵 USD/ARS 1,498 · BTC/ARS 119,301,632` |
| `!stats` | full one-liner with all rates |
| `!help` | command list |

Add commands by extending `commandReply()` in the script.

## Yadio API

The bot calls two endpoints per tick:

- `GET https://api.yadio.io/convert/1/BTC/ARS` → `{ rate, result, timestamp }` — ARS per BTC.
- `GET https://api.yadio.io/convert/1/USD/ARS` → ARS per USD (used to derive USD/BTC).

Yadio is community-run and rate-limit-friendly but not SLA'd. If it goes
down the bot logs a warning and skips the tick — the previous kind:0 stays
live until yadio recovers.

## Running

PM2 (production):

```bash
npm run pm2:start          # starts every bot in ecosystem.config.cjs
pm2 logs obelisk-sat-ars-bot
```

Foreground (debugging):

```bash
node --env-file-if-exists=.env.local bots/sat-ars-bot.mjs
```

## Verifying

```bash
pm2 logs obelisk-sat-ars-bot --lines 50
```

Healthy startup looks like:

```
[sat-ars-bot] env:         SAT_ARS_BOT_NSEC
[sat-ars-bot] pubkey npub: npub1...
[sat-ars-bot] relays:      wss://relay.obelisk.ar, wss://relay.damus.io, ...
[sat-ars-bot] groups:      (none)
[sat-ars-bot] interval:    60000ms; chat every 0 ticks
[sat-ars-bot] kind:0 → sat 1,20 ARS  (BTC $80,000 · USD/ARS 1.498)
```

Open the bot's npub in any Nostr client and confirm the display name
updates as the BTC/ARS rate moves.

## Adding it to a group

Same flow as price-bot. As a human admin of the target group:

```bash
ADMIN_NSEC=<your admin nsec> \
TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
TARGET_PUBKEY=<bot npub> \
  npm run add-member       # plain member, replies to slash-commands

# or, to make it a group admin:
TARGET_ROLES=admin npm run grant-admin
```

Then add `SAT_ARS_BOT_GROUPS=wss://relay.obelisk.ar|<groupId>` to
`.env.local` and `pm2 restart obelisk-sat-ars-bot`.
