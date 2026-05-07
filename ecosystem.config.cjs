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
      env: {
        NODE_ENV: 'production',
      },
    },
    // ── Add additional bots here ──
    // {
    //   name: 'obelisk-welcome-bot',
    //   script: 'bots/welcome-bot.mjs',
    //   cwd,
    //   node_args: nodeArgs,
    //   watch: false,
    //   autorestart: true,
    // },
  ],
};
