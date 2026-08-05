# AGENTS.md

Instructions for coding agents working in this repo (Codex reads this
file automatically — including runs launched from the Operator page on
https://agents.obelisk.ar).

**Read these two documents before changing anything:**

1. [AGENT.md](./AGENT.md) — the operational cheat sheet: mental model,
   lifecycle commands, common operations, troubleshooting.
2. [docs/building-bots.md](./docs/building-bots.md) — the complete guide
   to building a new bot and to Nostr/NIP-29 communication (subscribe /
   publish patterns, kind cheat-sheet, idempotency, state).

Non-negotiables (details in the docs above):

- Never print, invent, or commit an nsec. Secrets live in `.env.local`.
- Reuse `lib/` (`secret.mjs`, `pool.mjs`, `state.mjs`,
  `group-watcher.mjs`) — don't re-implement identity, AUTH, or state.
- One filter per subscription (`pool.subscribe`, never `subscribeMany`).
- Test a bot foreground (`node --env-file-if-exists=.env.local
  bots/<name>.mjs`) before touching PM2.
- The management web UI lives in `server/` (Node, no framework) and
  `frontend/` (Preact + Vite + Tailwind); it is deployed as the
  `obelisk-agents-manager` PM2 app on port 3021 → https://agents.obelisk.ar.
