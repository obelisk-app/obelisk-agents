// Bot registry: joins the PM2 view with each bot's Nostr identity and the
// env vars its source actually reads, so the UI can render a settings form
// per bot without hand-maintained schemas. Reuses the repo's CLI tools
// (new-bot, set-profile, list-groups) instead of reimplementing them.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getPublicKey, nip19 } from 'nostr-tools';
import { repoRoot, envLocalPath } from './config.mjs';
import { parseSecret } from '../lib/secret.mjs';
import { readEnvMap, readEnvEntries, applyEnvChanges } from './envfile.mjs';
import { listBots, ecosystemApps } from './pm2.mjs';

const execFileP = promisify(execFile);

// price-bot reads BOT_*; every other bot reads <NAME>_* with BOT_* fallback.
function envPrefix(botFile) {
  const base = path.basename(botFile, '.mjs');
  return base.toUpperCase().replace(/-/g, '_');
}

function scriptEnvVars(scriptPath) {
  try {
    const src = fs.readFileSync(path.join(repoRoot, scriptPath), 'utf8');
    return [...new Set([...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

function nsecEnvFor(app, env) {
  const prefix = envPrefix(app.script);
  if (env[`${prefix}_NSEC`] !== undefined) return `${prefix}_NSEC`;
  const declared = scriptEnvVars(app.script).find((v) => v.endsWith('_NSEC'));
  if (declared && declared !== 'BOT_NSEC') return declared;
  return 'BOT_NSEC';
}

function identityFor(nsecEnv, env) {
  try {
    const sk = parseSecret(env[nsecEnv]);
    const pk = getPublicKey(sk);
    return { pubkey: pk, npub: nip19.npubEncode(pk) };
  } catch {
    return { pubkey: null, npub: null };
  }
}

export async function botsOverview() {
  const env = readEnvMap();
  const entries = readEnvEntries();
  const procs = await listBots();
  return procs.map((proc) => {
    const app = ecosystemApps().find((a) => a.name === proc.name);
    const nsecEnv = nsecEnvFor(app, env);
    const vars = scriptEnvVars(app.script);
    return {
      ...proc,
      nsecEnv,
      ...identityFor(nsecEnv, env),
      envVars: vars.map((key) => entries.find((e) => e.key === key)
        ?? { key, secret: /NSEC/.test(key), set: false, value: '' }),
    };
  });
}

// ── Scaffold ────────────────────────────────────────────────────────────
// Runs tools/new-bot.mjs, captures the generated nsec, writes it straight
// into .env.local (never returned to the client) and registers a PM2 entry.
export async function scaffoldBot(rawName) {
  const name = String(rawName ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new Error('invalid bot name');
  const { stdout } = await execFileP('node', ['tools/new-bot.mjs', name], { cwd: repoRoot });
  const nsec = stdout.match(/nsec1[0-9a-z]+/)?.[0];
  const npub = stdout.match(/npub1[0-9a-z]+/)?.[0];
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_NSEC`;
  if (nsec) applyEnvChanges({ set: { [envName]: nsec } });
  addEcosystemEntry(name);
  return { name, npub, nsecEnv: envName, script: `bots/${name}.mjs` };
}

function addEcosystemEntry(name) {
  const ecoPath = path.join(repoRoot, 'ecosystem.config.cjs');
  const src = fs.readFileSync(ecoPath, 'utf8');
  const marker = '    // ── Add additional bots here ──';
  if (!src.includes(marker)) throw new Error('ecosystem.config.cjs marker not found');
  if (src.includes(`'obelisk-${name}'`)) return;
  const entry = `    {
      name: 'obelisk-${name}',
      script: 'bots/${name}.mjs',
      cwd,
      node_args: nodeArgs,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: baseEnv,
    },
${marker}`;
  fs.writeFileSync(ecoPath, src.replace(marker, entry));
}

// ── Profiles (kind 0) ───────────────────────────────────────────────────
export function publishProfile(name, profile) {
  return new Promise((resolve, reject) => {
    ecosystemAppOrThrow(name);
    const nsecEnv = nsecEnvFor(ecosystemAppOrThrow(name), readEnvMap());
    const child = spawn('node', [
      `--env-file-if-exists=${envLocalPath}`,
      'tools/set-profile.mjs',
      `--nsec-env=${nsecEnv}`,
    ], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.stdin.end(JSON.stringify(profile));
    child.on('close', (code) => {
      if (code === 0) resolve({ output: out.trim() });
      else reject(new Error(`set-profile exited ${code}: ${out.trim()}`));
    });
  });
}

function ecosystemAppOrThrow(name) {
  const app = ecosystemApps().find((a) => a.name === name);
  if (!app) throw new Error(`unknown bot: ${name}`);
  return app;
}

// ── Groups on a relay ───────────────────────────────────────────────────
export async function listGroups(relay) {
  if (!/^wss?:\/\//.test(relay)) throw new Error('relay must be a ws:// or wss:// URL');
  const { stdout } = await execFileP(
    'node', ['tools/list-groups.mjs', relay],
    { cwd: repoRoot, timeout: 20000 },
  );
  const groups = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+\[([^\]]+)\]\s+(.*)$/);
    if (m) groups.push({ id: m[1], access: m[2], name: m[3].split(' — ')[0], raw: m[3] });
  }
  return groups;
}
