// Bot registry: joins the PM2 view with each bot's Nostr identity and the
// env vars its source actually reads, so the UI can render a settings form
// per bot without hand-maintained schemas. Reuses the repo's CLI tools
// (new-bot, set-profile, list-groups) instead of reimplementing them.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getPublicKey, nip19 } from 'nostr-tools';
import { repoRoot, envLocalPath, adminPubkeys } from './config.mjs';
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

function botKind(scriptPath) {
  try {
    const src = fs.readFileSync(path.join(repoRoot, scriptPath), 'utf8');
    return src.includes('lib/agent-bot.mjs') ? 'agent' : 'bot';
  } catch {
    return 'bot';
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
      kind: botKind(app.script),
      nsecEnv,
      ...identityFor(nsecEnv, env),
      envVars: vars.map((key) => entries.find((e) => e.key === key)
        ?? { key, secret: /NSEC/.test(key), set: false, value: '' }),
    };
  });
}

// ── Scaffold ────────────────────────────────────────────────────────────
// Runs tools/new-bot.mjs, captures the generated nsec, writes it straight
// into .env.local (never returned to the client) along with the bot's
// relay/group lists, and registers a PM2 entry.
export async function scaffoldBot(rawName, {
  relays = [], groups = [], kind = 'bot', allowedPubkeys = [], systemPrompt = '',
} = {}) {
  const name = String(rawName ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new Error('invalid bot name');
  const args = ['tools/new-bot.mjs', name];
  if (kind === 'agent') args.push('--agent');
  const { stdout } = await execFileP('node', args, { cwd: repoRoot });
  const nsec = stdout.match(/nsec1[0-9a-z]+/)?.[0];
  const npub = stdout.match(/npub1[0-9a-z]+/)?.[0];
  const prefix = name.toUpperCase().replace(/-/g, '_');
  const set = {};
  if (nsec) set[`${prefix}_NSEC`] = nsec;
  if (relays.length) set[`${prefix}_RELAYS`] = relays.map(String).join(',');
  if (groups.length) set[`${prefix}_GROUPS`] = groups.map(String).join(',');
  if (kind === 'agent') {
    // Whitelist is the agent's security boundary — default to the manager
    // admins so a fresh agent hears its operator and nobody else.
    const allow = allowedPubkeys.length
      ? allowedPubkeys.map(String)
      : [...adminPubkeys].map((pk) => nip19.npubEncode(pk));
    set[`${prefix}_ALLOWED_PUBKEYS`] = allow.join(',');
    if (systemPrompt) set[`${prefix}_SYSTEM_PROMPT`] = systemPrompt.replace(/\s*\n\s*/g, ' ');
  }
  if (Object.keys(set).length) applyEnvChanges({ set });
  addEcosystemEntry(name);
  return { name, npub, nsecEnv: `${prefix}_NSEC`, prefix, kind, script: `bots/${name}.mjs` };
}

// Prompt handed to the Operator (Codex) right after scaffolding, so the
// agent implements the bot's actual behavior — data sources / scraping,
// chat interactions, intervals — against the configured relays/groups.
export function buildPrompt({ name, prefix, description, relays, groups, kind = 'bot' }) {
  if (kind === 'agent') {
    return [
      `A new Obelisk AGENT (LLM-connected bot) named ${name} was just scaffolded on the lib/agent-bot.mjs runtime.`,
      `Its entry point bots/${name}.mjs already works; env (identity, groups, whitelist, system prompt) is in .env.local.`,
      ``,
      `What the admin wants this agent to do:`,
      `"""`,
      description || '(no description — leave the default behavior)',
      `"""`,
      ``,
      `Read docs/agents.md and lib/agent-bot.mjs first. If the description fits the stock runtime, only refine ${prefix}_SYSTEM_PROMPT in .env.local (never print ${prefix}_NSEC or any *_LLM_API_KEY). If it needs extra behaviors (commands, scraping, scheduled posts), extend bots/${name}.mjs alongside runAgent() reusing lib/ helpers. Validate with node --check, foreground-test briefly, then pm2 restart obelisk-${name}. Do not touch other bots. Do not commit.`,
    ].join('\n');
  }
  return [
    `A new Obelisk bot was just scaffolded and is waiting to be implemented.`,
    ``,
    `Bot file: bots/${name}.mjs (PM2 app "obelisk-${name}").`,
    `Identity: env var ${prefix}_NSEC — already in .env.local. NEVER print or move it.`,
    relays?.length ? `Relays (${prefix}_RELAYS, already set): ${relays.join(', ')}` : `Relays: ${prefix}_RELAYS not set — default is wss://relay.obelisk.ar.`,
    groups?.length ? `Groups (${prefix}_GROUPS, already set): ${groups.join(', ')}` : `Groups: ${prefix}_GROUPS not set yet.`,
    ``,
    `What the admin wants this bot to do:`,
    `"""`,
    description || '(no description given — keep the scaffold behavior but clean it up)',
    `"""`,
    ``,
    `Follow AGENTS.md and docs/building-bots.md strictly. In particular:`,
    `- reuse lib/secret.mjs, lib/pool.mjs, lib/state.mjs (and lib/group-watcher.mjs for dynamic groups)`,
    `- read config only via process.env.${prefix}_* with BOT_* fallbacks so the manager UI picks the settings up`,
    `- external data (scraping / HTTP APIs): plain fetch with a sane interval, timeout and backoff — no new dependencies`,
    `- one filter per subscription; track seen event ids; ignore the bot's own events`,
    `- validate with node --check, then a short foreground test run (e.g. timeout 30s node --env-file-if-exists=.env.local bots/${name}.mjs) and confirm it prints "running as npub"`,
    `- when it works: pm2 restart obelisk-${name}`,
    `Do not touch other bots. Do not commit.`,
  ].join('\n');
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

// ── Avatar upload: frontend → manager → bot-signed Blossom upload →
// merged kind 0 published to relays ──────────────────────────────────────
function botSecret(name) {
  const app = ecosystemAppOrThrow(name);
  const env = readEnvMap();
  const nsecEnv = nsecEnvFor(app, env);
  const raw = env[nsecEnv];
  if (!raw) throw new Error(`${nsecEnv} is not set in .env.local`);
  const sk = parseSecret(raw);
  return { sk, pk: getPublicKey(sk), nsecEnv };
}

const PROFILE_RELAYS = ['wss://relay.obelisk.ar', 'wss://relay.damus.io', 'wss://purplepag.es', 'wss://relay.nostr.band'];

async function fetchProfile(name) {
  const { sk, pk } = botSecret(name);
  const { createPool } = await import('../lib/pool.mjs');
  const pool = createPool(sk);
  try {
    const ev = await Promise.race([
      pool.get(PROFILE_RELAYS, { kinds: [0], authors: [pk] }),
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    return ev ? JSON.parse(ev.content) : {};
  } catch {
    return {};
  } finally {
    pool.close(PROFILE_RELAYS);
  }
}

export async function setAvatar(name, buffer, mime) {
  if (!/^image\//.test(mime)) throw new Error('expected an image upload');
  const { sk } = botSecret(name);
  const { uploadToBlossom } = await import('./media.mjs');
  const { url } = await uploadToBlossom(sk, buffer, mime);
  // kind 0 is replaceable — merge with the current profile so setting the
  // picture never blanks the name/about.
  const existing = await fetchProfile(name);
  const { output } = await publishProfile(name, { ...existing, picture: url });
  return { url, output };
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
