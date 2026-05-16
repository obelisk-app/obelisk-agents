# Zap Bot

> **Status: WIP.** End-to-end works on synthetic NIP-57 receipts (see
> `tools/simulate-zap.mjs`) and announcements render correctly with
> `nostr:npub1…` mentions. The bot now listens for both classic kind 9735
> zap receipts and group-local kind 7 `⚡` zap reactions. Amountless
> `⚡` reactions are observed on the relays and are skipped because the
> announcement template needs a parseable amount.

`bots/zap-bot.mjs` — listens for [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md)
zap receipts plus zap-like reactions in NIP-29 groups and announces them
in chat:

```
⚡ nostr:npub1m9vsm9d… sent 420 satoshis to nostr:npub1jecfrph…
```

Inspired by the Telegram **LN Zap Bot**.

## How a zap reaches the group

1. Alice's NIP-29-aware client builds a kind 9734 **zap request** whose
   tags include `["h", groupId]` alongside `["p", bobHex]`, `["e", msgId]`,
   `["amount", millisats]`, `["relays", "wss://relay.obelisk.ar", …]`.
2. Alice's wallet pays the bolt11 it gets back from Bob's LNURL provider.
3. Clients such as 0xchat may publish an in-group **kind 7 `⚡` reaction**
   with `h`, `e`, `p`, and amount or `bolt11` metadata. LNURL providers
   may instead publish a **kind 9735 zap receipt** to every relay listed
   in the request.
4. If the relay accepts either event, zap-bot's `#h`-filtered subscription
   delivers it, the bot resolves sender/recipient kind:0 names, and posts
   a kind 9 announcement back to the group.

The bot also accepts receipts whose **embedded zap request** carries the
group's `h`-tag, even if the receipt itself doesn't — this covers relays
or LNURL providers that strip custom tags during ingest.

## Capabilities

| # | Capability | Event kinds | Notes |
|---|---|---|---|
| 1 | Zap event listener | kind 7, 9735 | subscribes per-group with `#h: [groupId]`, reconnects on close with jittered backoff. |
| 2 | Group announcement | kind 9 | one message per parseable zap event, e-tagged to the zapped note. |
| 3 | Name resolution | kind 0 | lazy, cached in memory; falls back to short npub. |
| 4 | Group hello + join-request | kind 9, 9021 | one-shot per group, throttled when joining many at once. |
| 5 | Dynamic group discovery | kind 39000 | watches `ZAP_BOT_LISTEN_RELAYS` and auto-subscribes to open groups. |
| 6 | Amount parsing | — | receipts use `amount` / zap request `amount` / `bolt11`; reactions use `bolt11` / amount tags. |
| 7 | NIP-42 AUTH | kind 22242 | auto-AUTH via `lib/pool.mjs`. |
| 8 | Health heartbeat | — | logs counts of subs / zap events / announces every `ZAP_BOT_HEARTBEAT_MS`. |

The bot does **not** publish kind:0 metadata (no ticker face). Run
`npm run set-profile -- --nsec-env=ZAP_BOT_NSEC` once if you want a
display name + avatar.

## Configuration

Per-bot env vars take precedence; `BOT_*` shared vars are fallback only.
**Use a separate nsec from price-bot / sat-ars-bot** — never share an
identity across bots.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ZAP_BOT_NSEC` | yes | — | nsec1... or 64-char hex. |
| `ZAP_BOT_RELAYS` | no | `BOT_RELAYS` or `wss://relay.obelisk.ar` | used for kind:0 lookups. |
| `ZAP_BOT_GROUPS` | no | `BOT_GROUPS` or empty | static `relayUrl|groupId` seeds — always watched. |
| `ZAP_BOT_LISTEN_RELAYS` | no | empty | relays to scan via kind 39000 and auto-subscribe to every open group on. Refreshed every `ZAP_BOT_REFRESH_MS`. |
| `ZAP_BOT_REFRESH_MS` | no | `600000` | discovery refresh cadence (min 60 s). |
| `ZAP_BOT_RECONNECT_MS` | no | `10000` | base reconnect delay per group; uniform 0..1× jitter is added. |
| `ZAP_BOT_HELLO` | no | `1` | set `0` to skip the per-group "online" announcement. |
| `ZAP_BOT_HELLO_THROTTLE_MS` | no | `4000` | gap between hellos when first joining many groups. |
| `ZAP_BOT_HEARTBEAT_MS` | no | `300000` | how often to print an `alive — N groups, M zap events…` line. |
| `ZAP_BOT_SEEN_MAX` | no | `10000` | FIFO dedup-cache cap; oldest IDs evict first. |
| `ZAP_BOT_MIN_SATS` | no | `1` | suppress zaps below this amount. |
| `ZAP_BOT_TEMPLATE` | no | `⚡ ${sender} sent ${amount} ${unit} to ${recipient}` | tokens: `${sender}`, `${recipient}`, `${amount}`, `${unit}` (`satoshi`/`satoshis`). |

### Static vs dynamic groups

- **Static** (`ZAP_BOT_GROUPS`) is the explicit list — useful when you want one tightly-scoped bot or for relays you don't want fully scanned.
- **Dynamic** (`ZAP_BOT_LISTEN_RELAYS`) makes the bot scan kind 39000 on those relays at startup and every `ZAP_BOT_REFRESH_MS`. Every **open** group it finds is auto-subscribed; closed groups are skipped (the bot can't post in them without an explicit admit). Groups that disappear between refreshes are unsubscribed.
- The two lists merge — a static seed is always watched even if discovery drops it.

## Amount resolution

For kind 9735 receipts, three sources are tried in priority order, all
in millisats internally:

1. **Receipt `amount` tag** — most authoritative, set by spec-compliant LNURL providers.
2. **Zap request `amount` tag** — parsed from the receipt's `description` JSON.
3. **bolt11 invoice** — last resort, parsed with a tiny inline decoder
   that handles the `m`/`u`/`n`/`p` multipliers per BOLT-11.

For kind 7 `⚡` reactions, the bot tries the `bolt11` tag first, then
`amount`/`msat`/`msats`/`millisats` tags, then `sat`/`sats` tags. The
plain `amount` tag follows the NIP-57 millisat convention unless the tag
includes a sat unit hint, for example `["amount","21","sat"]`.

If none yield an amount the zap event is skipped with a warning.

## Sender / recipient naming

For each zap event the bot looks up `display_name` → `displayName` → `name`
in the most recent kind:0 it can find for that pubkey across
`ZAP_BOT_RELAYS` plus the group relays. Results are cached in memory.
First-time references render as `@npub1xxxxxxxx…` while resolution is
in flight (timeout 5 s).

## Running

PM2 (production):

```bash
npm run pm2:start          # starts every bot in ecosystem.config.cjs
pm2 logs obelisk-zap-bot
```

Foreground (debugging):

```bash
node --env-file-if-exists=.env.local bots/zap-bot.mjs
# or:
npm run zap-bot
```

## Verifying

```bash
pm2 logs obelisk-zap-bot --lines 50
```

Healthy startup:

```
[zap-bot] env:             ZAP_BOT_NSEC
[zap-bot] pubkey npub:     npub1…
[zap-bot] relays:          wss://relay.obelisk.ar, wss://relay.damus.io
[zap-bot] static groups:   wss://relay.obelisk.ar|abcdef0123456789
[zap-bot] listen relays:   wss://relay.obelisk.ar, wss://public.obelisk.ar, wss://lacrypta-relay.obelisk.ar
[zap-bot] refresh:         600000ms;  reconnect base 10000ms
[zap-bot] +group wss://relay.obelisk.ar abcdef01 (💬 chat-general)
[zap-bot] join-request sent: wss://relay.obelisk.ar abcdef01
[zap-bot] hello sent: wss://relay.obelisk.ar abcdef01
[zap-bot] alive — 51 groups, 0 zap events (0 receipts, 0 reactions), 0 announced, 0 filtered, 0 errors, 0 cached, up 5m
```

On a real zap:

```
[zap-bot] announced 420 satoshis: @alice → @bob on abcdef01
```

## Adding it to a group

Same flow as the other bots. As a human admin of the target group:

```bash
ADMIN_NSEC=<your admin nsec> \
TARGET_GROUP="wss://relay.obelisk.ar|<groupId>" \
TARGET_PUBKEY=<bot npub> \
  npm run add-member       # plain member — sufficient for posting kind 9
```

Then add `ZAP_BOT_GROUPS=wss://relay.obelisk.ar|<groupId>` to
`.env.local` and `pm2 restart obelisk-zap-bot`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot is silent on every zap | No kind 7 `⚡` reaction or kind 9735 receipt with `["h", groupId]` is reaching the group's relay. Run `node --env-file-if-exists=.env.local tools/find-zap-reactions.mjs 24` to inspect reaction-style zaps. |
| Bot announces with short npubs forever | kind:0 not findable on configured relays. Add `wss://relay.damus.io`, `wss://relay.nostr.band` to `ZAP_BOT_RELAYS`. |
| `receipt …: no parseable amount` | Receipt lacks `amount` tag, has no `description`, and bolt11 is malformed. Probably a non-spec LNURL provider. |
| `reaction …: no parseable amount` | Kind 7 `⚡` reaction has `h`/`e`/`p` tags but no amount or `bolt11` metadata. The bot sees it but cannot announce a sat amount. |
| `announce failed: not admitted` | Run `npm run add-member` (or `grant-admin`) for the bot's npub on the group. |
| Bot duplicates announcements after restart | Dedup is in-memory only; on restart relays may re-deliver. Bound by the bot's `since = now - 5s` window, so duplicates are rare. |

## Notes & limits

- **In-memory dedup**: the `seen` Set survives only within a single process. PM2 restarts can re-announce zaps that arrive again within 5 seconds of startup.
- **No state file for zap events**: only the join/greeted state is persisted (in `~/.obelisk-zap-bot-state.json`).
- **No anti-spam rate limiting**: a zap-spammer can flood the group. Set `ZAP_BOT_MIN_SATS` to filter dust.
- **Bot's own zaps are skipped** (sender == bot pk). Zaps **to** the bot are also skipped.
