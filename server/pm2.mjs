// PM2 as the single control plane: every bot in ecosystem.config.cjs is
// listed, started, stopped, restarted and tailed from here. Only names
// declared in the ecosystem file are accepted — the manager can't touch
// unrelated PM2 processes.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { ecosystemPath } from './config.mjs';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

const MANAGER_APP = 'obelisk-agents-manager';

export function ecosystemApps() {
  delete require.cache[require.resolve(ecosystemPath)];
  const { apps } = require(ecosystemPath);
  // The manager itself is in the ecosystem file but is not a bot — hide
  // it from the fleet so the UI can't stop its own server.
  return apps.filter((a) => a.name !== MANAGER_APP);
}

export function assertManagedName(name) {
  const app = ecosystemApps().find((a) => a.name === name);
  if (!app) throw new Error(`"${name}" is not a bot declared in ecosystem.config.cjs`);
  return app;
}

async function pm2Json() {
  const { stdout } = await execFileP('pm2', ['jlist'], { maxBuffer: 16 * 1024 * 1024 });
  // pm2 sometimes prefixes jlist with daemon chatter; the JSON is the last line.
  const jsonLine = stdout.slice(stdout.indexOf('['));
  return JSON.parse(jsonLine);
}

function lastLogLine(file) {
  if (!file) return null;
  const lines = tailFile(file, 4 * 1024).split('\n').filter((l) => l.trim());
  return lines.at(-1) ?? null;
}

export async function listBots() {
  const procs = await pm2Json().catch(() => []);
  const byName = new Map(procs.map((p) => [p.name, p]));
  return ecosystemApps().map((app) => {
    const p = byName.get(app.name);
    return {
      lastLog: lastLogLine(p?.pm2_env?.pm_out_log_path),
      name: app.name,
      script: app.script,
      status: p?.pm2_env?.status ?? 'not started',
      pid: p?.pid || null,
      uptime: p?.pm2_env?.pm_uptime && p?.pm2_env?.status === 'online'
        ? Date.now() - p.pm2_env.pm_uptime : null,
      restarts: p?.pm2_env?.restart_time ?? 0,
      cpu: p?.monit?.cpu ?? null,
      memory: p?.monit?.memory ?? null,
      outLog: p?.pm2_env?.pm_out_log_path || null,
      errLog: p?.pm2_env?.pm_err_log_path || null,
    };
  });
}

export async function botAction(name, action) {
  assertManagedName(name);
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`bad action: ${action}`);
  // `pm2 start <name>` only works for known processes; cold-start goes
  // through the ecosystem file scoped with --only.
  const args = action === 'start'
    ? ['start', ecosystemPath, '--only', name]
    : [action, name];
  await execFileP('pm2', args, { maxBuffer: 4 * 1024 * 1024 });
  await execFileP('pm2', ['save'], { maxBuffer: 4 * 1024 * 1024 }).catch(() => {});
}

const TAIL_BYTES = 64 * 1024;

function tailFile(file, maxBytes = TAIL_BYTES) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    // Drop a partial first line when we started mid-file.
    return size > maxBytes ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

export async function botLogs(name, { lines = 200 } = {}) {
  assertManagedName(name);
  const bots = await listBots();
  const bot = bots.find((b) => b.name === name);
  const take = (text) => text.split('\n').filter(Boolean).slice(-lines);
  return {
    out: bot?.outLog ? take(tailFile(bot.outLog)) : [],
    err: bot?.errLog ? take(tailFile(bot.errLog)) : [],
  };
}
