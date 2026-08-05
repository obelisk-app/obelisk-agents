// PM2 ecosystem config for Obelisk bots.
//
// Each entry is a long-running bot process. Add new entries below as you
// scaffold bots with `npm run new-bot -- <name>`.
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

module.exports = {
  apps: [
    {
      name: 'obelisk-price-bot',
      script: 'bots/price-bot.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
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
      name: 'obelisk-zap-bot',
      script: 'bots/zap-bot.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    {
      name: 'obelisk-este-sech',
      script: 'bots/este-sech.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
    // ── Add additional bots here ──

    // Management web UI + API (bots.obelisk.ar). Not a bot: it is the
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
