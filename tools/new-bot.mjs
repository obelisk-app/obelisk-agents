#!/usr/bin/env node
// Scaffold a new bot: generate an nsec, write a starter file under bots/,
// print the npub so you can whitelist / admit the bot.
//
// Usage:
//   npm run new-bot -- <name>
//   npm run new-bot -- welcome-bot
//
// Creates:
//   bots/<name>.mjs               — minimal listener+publisher template
//   prints the bot's nsec/npub    — copy nsec into .env.local under <NAME>_NSEC
//
// The script never writes secrets to disk. Pipe to `tee` if you want a copy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../lib/secret.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const isAgent = process.argv.includes('--agent');
const rawName = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawName) {
  console.error('Usage: npm run new-bot -- <name> [--agent]');
  console.error('  --agent  scaffold an LLM-connected agent (lib/agent-bot.mjs runtime)');
  process.exit(1);
}
const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
if (!name) {
  console.error(`invalid bot name: "${rawName}"`);
  process.exit(1);
}

const filePath = path.join(root, 'bots', `${name}.mjs`);
if (fs.existsSync(filePath)) {
  console.error(`bots/${name}.mjs already exists — pick another name or delete the file.`);
  process.exit(1);
}

const { sk, pk, npub, nsec } = newIdentity();

const ENV = name.toUpperCase().replace(/-/g, '_');

const agentTemplate = `#!/usr/bin/env node
// ${name} — Obelisk **agent**: an LLM-connected bot that only listens to
// whitelisted users. All behavior lives in lib/agent-bot.mjs; this file is
// just the entry point. Configure via env (see docs/agents.md):
//
//   ${ENV}_NSEC              identity (already generated)
//   ${ENV}_GROUPS            wss://relay|groupId,…
//   ${ENV}_ALLOWED_PUBKEYS   npubs allowed to talk to it (comma-separated)
//   ${ENV}_SYSTEM_PROMPT     persona / instructions
//   ${ENV}_LLM_API_KEY       + ${ENV}_LLM_PROVIDER (anthropic | openai),
//                            or global ANTHROPIC_API_KEY / OPENAI_API_KEY
//
// Pubkey:  ${pk}
// npub:    ${npub}
import { runAgent } from '../lib/agent-bot.mjs';

runAgent({ name: '${name}', envPrefix: '${ENV}' });

// Keep the process alive through relay disconnects (PM2 would otherwise
// see a clean exit and restart-loop us).
setInterval(() => {}, 60_000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

const template = isAgent ? agentTemplate : `#!/usr/bin/env node
// ${name} — Obelisk bot scaffold.
// Identity:  ${ENV}_NSEC  (or BOT_NSEC if you only run one bot)
// Pubkey:    ${pk}
// npub:      ${npub}
//
// Configure in .env.local, then run:
//   npm run pm2:start    (registers via ecosystem.config.js)
// or for one-off testing:
//   node --env-file-if-exists=.env.local bots/${name}.mjs

import { finalizeEvent } from 'nostr-tools';
import { identityFromEnv } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';

const { sk, pk, npub } = identityFromEnv(process.env.${ENV}_NSEC ? '${ENV}_NSEC' : 'BOT_NSEC');
const RELAYS = (process.env.${ENV}_RELAYS || process.env.BOT_RELAYS || 'wss://relay.obelisk.ar')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROUPS = parseGroupList(process.env.${ENV}_GROUPS || process.env.BOT_GROUPS);

const pool = createPool(sk);

console.log(\`[${name}] running as \${npub}\`);
console.log(\`[${name}] relays:  \${RELAYS.join(', ')}\`);
console.log(\`[${name}] groups:  \${GROUPS.map(g => \`\${g.relay}|\${g.groupId}\`).join(', ') || '(none)'}\`);

// Example: subscribe to chat in each configured group and react.
for (const { relay, groupId } of GROUPS) {
  pool.subscribe(
    [relay],
    { kinds: [9], '#h': [groupId], since: Math.floor(Date.now() / 1000) },
    {
      onauth: async () => null,
      onevent: async (ev) => {
        if (ev.pubkey === pk) return;
        // TODO: react. For example, echo back any '!ping':
        if (ev.content.trim() === '!ping') {
          const reply = finalizeEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['h', groupId], ['e', ev.id], ['p', ev.pubkey]],
            content: 'pong',
          }, sk);
          try { await Promise.any(pool.publish([relay], reply)); } catch {}
        }
      },
    },
  );
}

// Keep the process alive through relay disconnects (PM2 would otherwise
// see a clean exit and restart-loop us).
setInterval(() => {}, 60_000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

fs.writeFileSync(filePath, template);

console.log(`\nCreated bots/${name}.mjs`);
console.log('\n┌─ Bot identity (save somewhere safe) ─────────────────────');
console.log(`│  npub:  ${npub}`);
console.log(`│  hex:   ${pk}`);
console.log(`│  nsec:  ${nsec}`);
console.log('└──────────────────────────────────────────────────────────');
console.log('\nNext steps:');
console.log(`  1. Add to .env.local:    ${ENV}_NSEC=${nsec}`);
console.log(`     (or use BOT_NSEC=${nsec} if this is your only bot)`);
console.log(`  2. Whitelist the npub on your relay if it enforces an allow-list.`);
console.log(`  3. Add to a group:       npm run grant-admin   (or)   npm run add-member`);
console.log(`  4. Edit bots/${name}.mjs to implement the bot's actual behavior.`);
console.log(`  5. Start under PM2:      add the entry to ecosystem.config.js, then:`);
console.log(`                           npm run pm2:start`);
