// AI operator, hermes-agent style: the manager rides the Codex CLI's own
// credentials (~/.codex/auth.json), so it works the same whether the CLI is
// signed in with a ChatGPT/Codex subscription or with API credits
// (OPENAI_API_KEY). Tasks run as `codex exec` inside this repo and stream
// their event log to the UI. No token ever leaves the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot, stateDir, codexAuthPath } from './config.mjs';

const execFileP = promisify(execFile);
const runsDir = path.join(stateDir, 'agent-runs');
const active = new Map(); // id -> { child, subscribers:Set<res> }

function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function agentStatus() {
  let auth = null;
  try {
    auth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
  } catch { /* not logged in */ }
  const version = await execFileP('codex', ['--version'])
    .then(({ stdout }) => stdout.trim()).catch(() => null);
  if (!auth) return { installed: !!version, version, mode: 'none' };

  const claims = auth.tokens?.id_token ? decodeJwtPayload(auth.tokens.id_token) : {};
  const openaiClaims = claims['https://api.openai.com/auth'] ?? {};
  const hasSubscription = !!auth.tokens?.access_token;
  const hasApiKey = !!auth.OPENAI_API_KEY;
  return {
    installed: !!version,
    version,
    // auth_mode is what codex will actually use; fall back on what exists.
    mode: auth.auth_mode ?? (hasSubscription ? 'chatgpt' : hasApiKey ? 'apikey' : 'none'),
    hasSubscription,
    hasApiKey,
    email: claims.email ?? null,
    plan: openaiClaims.chatgpt_plan_type ?? null,
    lastRefresh: auth.last_refresh ?? null,
  };
}

export function loginWithApiKey(key) {
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(String(key ?? ''))) {
    throw new Error('that does not look like an OpenAI API key');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['login', '--with-api-key'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.stdin.end(key + '\n');
    child.on('close', (code) => {
      if (code === 0) resolve(agentStatus());
      else reject(new Error(`codex login failed: ${out.trim()}`));
    });
  });
}

export async function logoutCodex() {
  await execFileP('codex', ['logout']).catch(() => {});
  return agentStatus();
}

// ── Headless subscription login (device flow) ───────────────────────────
// `codex login --device-auth` prints a URL + one-time code; we surface that
// output so the admin can finish the flow from any browser.
let deviceAuth = null; // { child, output, startedAt, done, ok }

export function startDeviceAuth() {
  if (deviceAuth && !deviceAuth.done) return deviceAuthStatus();
  const child = spawn('codex', ['login', '--device-auth'], { env: { ...process.env, NO_COLOR: '1' } });
  deviceAuth = { child, output: '', startedAt: Date.now(), done: false, ok: null };
  const collect = (c) => { deviceAuth.output += String(c); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('close', (code) => {
    deviceAuth.done = true;
    deviceAuth.ok = code === 0;
  });
  // Don't let an abandoned flow hang forever.
  setTimeout(() => { if (!deviceAuth.done) child.kill('SIGTERM'); }, 15 * 60 * 1000).unref();
  return deviceAuthStatus();
}

export function deviceAuthStatus() {
  if (!deviceAuth) return { active: false };
  return {
    active: !deviceAuth.done,
    done: deviceAuth.done,
    ok: deviceAuth.ok,
    output: deviceAuth.output.slice(-4000),
  };
}

export function cancelDeviceAuth() {
  if (deviceAuth && !deviceAuth.done) deviceAuth.child.kill('SIGTERM');
}

// ── Runs ────────────────────────────────────────────────────────────────

function runPath(id) {
  return path.join(runsDir, `${id}.json`);
}

function saveRun(run) {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(runPath(run.id), JSON.stringify(run));
}

export function listRuns() {
  try {
    return fs.readdirSync(runsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')))
      .map(({ events, ...meta }) => meta)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function getRun(id) {
  return JSON.parse(fs.readFileSync(runPath(sanitizeId(id)), 'utf8'));
}

function sanitizeId(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('bad run id');
  return id;
}

function broadcast(run, payload) {
  const entry = active.get(run.id);
  if (!entry) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of entry.subscribers) res.write(data);
}

export function startRun(prompt) {
  if (!fs.existsSync(codexAuthPath)) {
    throw new Error('codex is not logged in — connect a subscription or API key first');
  }
  const id = crypto.randomBytes(8).toString('hex');
  const run = {
    id,
    prompt: String(prompt),
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    events: [],
  };
  // workspace-write: the agent can edit this repo but nothing outside it.
  // Extra flags (e.g. a model override) come from MANAGER_CODEX_ARGS.
  const extra = (process.env.MANAGER_CODEX_ARGS ?? '').split(' ').filter(Boolean);
  const child = spawn('codex', [
    'exec', '--json', '--sandbox', 'workspace-write', '--cd', repoRoot, ...extra, run.prompt,
  ], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });
  active.set(id, { child, subscribers: new Set(), run });

  let buf = '';
  const onEvent = (event) => {
    run.events.push(event);
    broadcast(run, event);
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        onEvent({ type: 'raw', text: line });
      }
    }
  });
  child.stderr.on('data', (chunk) => onEvent({ type: 'stderr', text: String(chunk) }));
  child.on('close', (code) => {
    run.status = code === 0 ? 'done' : 'failed';
    run.finishedAt = Date.now();
    run.exitCode = code;
    saveRun(run);
    broadcast(run, { type: 'finished', status: run.status, exitCode: code });
    for (const res of active.get(id)?.subscribers ?? []) res.end();
    active.delete(id);
  });
  saveRun(run);
  return { id };
}

export function killRun(id) {
  const entry = active.get(sanitizeId(id));
  if (!entry) throw new Error('run is not active');
  entry.child.kill('SIGTERM');
}

// SSE: replay what happened so far, then follow along. Active runs keep
// their event log in memory (disk is only written on completion).
export function streamRun(id, res) {
  const run = active.get(sanitizeId(id))?.run ?? getRun(id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  const entry = active.get(id);
  if (!entry) {
    res.write(`data: ${JSON.stringify({ type: 'finished', status: run.status, exitCode: run.exitCode ?? null })}\n\n`);
    res.end();
    return;
  }
  entry.subscribers.add(res);
  res.on('close', () => entry.subscribers.delete(res));
}
