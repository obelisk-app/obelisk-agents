// PM2 ecosystem config for Obelisk bots.
//
// Each entry is a long-running bot process. Official bots come from
// official/catalog.json (see officialApps below); add your own entries
// below as you scaffold bots with `npm run new-bot -- <name>`.
//
// Start / reload:
//   pm2 start ecosystem.config.js && pm2 save
// Restart a single bot:
//   pm2 restart obelisk-price-bot
//
// Secrets live in `.env.local` (gitignored). PM2 reads them via Node's
// `--env-file-if-exists` flag set as `node_args`.

const cwd = __dirname;
const nodeArgs = `--env-file-if-exists=${cwd}/.env.local`;
const stateDir = '/var/lib/obelisk-agents/state';
const baseEnv = {
  NODE_ENV: 'production',
  OBELISK_AGENTS_STATE_DIR: stateDir,
};

// Official bots (official/catalog.json) are off by default: each one is
// registered only once its nsec is set in .env.local, so a fresh clone's
// `pm2 start ecosystem.config.cjs` starts nothing with a missing identity.
// The manager sets OBELISK_ECOSYSTEM_ALL=1 to list them all and turns them
// on from the dashboard.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

function localEnv() {
  try {
    return parseEnv(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8'));
  } catch {
    return {};
  }
}

function officialApps() {
  const { bots } = JSON.parse(fs.readFileSync(path.join(cwd, 'official/catalog.json'), 'utf8'));
  const env = localEnv();
  const all = process.env.OBELISK_ECOSYSTEM_ALL === '1';
  return bots
    .filter((b) => all || env[b.nsecEnv])
    .map((b) => ({
      name: `obelisk-${b.id}`,
      script: `official/${b.id}.mjs`,
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    }));
}

module.exports = {
  apps: [
    ...officialApps(),
    {
      name: 'obelisk-sat-ars-bot',
      script: 'bots/sat-ars-bot.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    {
      name: 'obelisk-empanadas-price-bot',
      script: 'bots/empanadas-price-bot.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    {
      name: 'obelisk-precio-latas-atun',
      script: 'bots/precio-latas-atun.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    {
      name: 'obelisk-asados-bot',
      script: 'bots/asados-bot.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    // ── Add additional bots here ──

    // Management web UI + API (agents.obelisk.ar). Not a bot: it is the
    // control plane for everything above.
    {
      name: 'obelisk-agents-manager',
      script: 'server/index.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
  ],
};
