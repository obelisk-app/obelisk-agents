#!/usr/bin/env node
// bots.obelisk.ar — management server for the Obelisk bot fleet.
// Plain node:http, no framework: same zero-dependency spirit as the bots.
//
//   node --env-file-if-exists=.env.local server/index.mjs
//
// Auth: Nostr only. GET /api/auth/challenge → sign kind 22242 → POST
// /api/auth/login. Only MANAGER_ADMIN_NPUBS (default: the owner npub)
// get in.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PORT, repoRoot, distDir } from './config.mjs';
import { issueChallenge, login, logout, sessionFor, sessionCookie } from './auth.mjs';
import { readEnvEntries, applyEnvChanges } from './envfile.mjs';
import { botAction, botLogs } from './pm2.mjs';
import { botsOverview, scaffoldBot, buildPrompt, publishProfile, listGroups, setAvatar } from './bots.mjs';
import * as agent from './agent.mjs';

const routes = [];
const route = (method, pattern, handler, { open = false, raw = false } = {}) =>
  routes.push({ method, pattern, handler, open, raw });

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ── Auth ────────────────────────────────────────────────────────────────
route('GET', /^\/api\/auth\/challenge$/, (req, res) =>
  json(res, 200, { challenge: issueChallenge() }), { open: true });

route('POST', /^\/api\/auth\/login$/, (req, res, m, body) => {
  const token = login(body?.event);
  res.setHeader('Set-Cookie', sessionCookie(token));
  json(res, 200, { ok: true });
}, { open: true });

route('GET', /^\/api\/auth\/session$/, (req, res) => {
  const s = sessionFor(req);
  json(res, 200, s ? { authed: true, npub: s.npub } : { authed: false });
}, { open: true });

route('POST', /^\/api\/auth\/logout$/, (req, res) => {
  const s = sessionFor(req);
  if (s) logout(s.token);
  res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
  json(res, 200, { ok: true });
}, { open: true });

// ── Bots ────────────────────────────────────────────────────────────────
route('GET', /^\/api\/bots$/, async (req, res) => json(res, 200, await botsOverview()));

// Scaffold a bot; with build:true (and Codex connected) the Operator
// immediately gets a run that implements the described behavior.
route('POST', /^\/api\/bots$/, async (req, res, m, body) => {
  const created = await scaffoldBot(body?.name, {
    relays: Array.isArray(body?.relays) ? body.relays : [],
    groups: Array.isArray(body?.groups) ? body.groups : [],
    kind: body?.kind === 'agent' ? 'agent' : 'bot',
    allowedPubkeys: Array.isArray(body?.allowedPubkeys) ? body.allowedPubkeys : [],
    systemPrompt: String(body?.systemPrompt ?? ''),
  });
  let runId = null;
  if (body?.build) {
    const status = await agent.agentStatus();
    if (status.mode === 'none') throw new Error(`scaffolded ${created.name}, but Codex is not connected — build skipped`);
    runId = agent.startRun(buildPrompt({
      ...created,
      description: String(body?.description ?? ''),
      relays: body?.relays,
      groups: body?.groups,
    })).id;
  }
  json(res, 200, { ...created, runId });
});

route('DELETE', /^\/api\/bots\/([\w-]+)$/, async (req, res, m) => {
  const { removeBot } = await import('./bots.mjs');
  json(res, 200, await removeBot(m[1]));
});

route('POST', /^\/api\/bots\/([\w-]+)\/(start|stop|restart)$/, async (req, res, m) => {
  await botAction(m[1], m[2]);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/bots\/([\w-]+)\/logs$/, async (req, res, m, body, url) =>
  json(res, 200, await botLogs(m[1], { lines: Number(url.searchParams.get('lines')) || 200 })));

route('POST', /^\/api\/bots\/([\w-]+)\/profile$/, async (req, res, m, body) =>
  json(res, 200, await publishProfile(m[1], body ?? {})));

// Avatar flow: raw image body → bot-signed Blossom upload → merged kind 0
// published to the profile relays.
route('POST', /^\/api\/bots\/([\w-]+)\/avatar$/, async (req, res, m, body) =>
  json(res, 200, await setAvatar(m[1], body, req.headers['content-type'] ?? 'application/octet-stream')),
  { raw: true });

// ── Settings (.env.local) ───────────────────────────────────────────────
route('GET', /^\/api\/env$/, (req, res) => json(res, 200, readEnvEntries()));

route('PUT', /^\/api\/env$/, (req, res, m, body) => {
  applyEnvChanges(body ?? {});
  json(res, 200, { ok: true, entries: readEnvEntries() });
});

// ── Relay tools ─────────────────────────────────────────────────────────
route('GET', /^\/api\/groups$/, async (req, res, m, body, url) =>
  json(res, 200, await listGroups(url.searchParams.get('relay') || 'wss://relay.obelisk.ar')));

// ── AI operator (Codex) ─────────────────────────────────────────────────
route('GET', /^\/api\/agent\/status$/, async (req, res) => json(res, 200, await agent.agentStatus()));
route('POST', /^\/api\/agent\/api-key$/, async (req, res, m, body) =>
  json(res, 200, await agent.loginWithApiKey(body?.key)));
route('POST', /^\/api\/agent\/logout$/, async (req, res) => json(res, 200, await agent.logoutCodex()));
route('POST', /^\/api\/agent\/device-auth$/, (req, res) => json(res, 200, agent.startDeviceAuth()));
route('GET', /^\/api\/agent\/device-auth$/, (req, res) => json(res, 200, agent.deviceAuthStatus()));
route('DELETE', /^\/api\/agent\/device-auth$/, (req, res) => {
  agent.cancelDeviceAuth();
  json(res, 200, { ok: true });
});
route('GET', /^\/api\/agent\/runs$/, (req, res) => json(res, 200, agent.listRuns()));
route('GET', /^\/api\/agent\/activity$/, (req, res) => json(res, 200, agent.activity()));

// Script inventory: every bot file with size, mtime and git state, so
// operator-created scripts are visible the moment they appear on disk.
route('GET', /^\/api\/workspace\/scripts$/, async (req, res) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const status = await promisify(execFile)('git', ['status', '--porcelain', '--', 'bots', 'lib', 'tools'], { cwd: repoRoot })
    .then(({ stdout }) => stdout).catch(() => '');
  const gitState = new Map();
  for (const line of status.split('\n')) {
    const m = line.match(/^(..) (.+)$/);
    if (m) gitState.set(m[2].trim(), m[1].includes('?') ? 'new' : 'modified');
  }
  const scripts = [];
  for (const dir of ['bots', 'lib', 'tools']) {
    for (const f of fs.readdirSync(path.join(repoRoot, dir)).filter((f) => f.endsWith('.mjs'))) {
      const rel = `${dir}/${f}`;
      const st = fs.statSync(path.join(repoRoot, rel));
      scripts.push({ file: rel, size: st.size, mtime: st.mtimeMs, git: gitState.get(rel) ?? 'committed' });
    }
  }
  scripts.sort((a, b) => b.mtime - a.mtime);
  json(res, 200, scripts);
});
route('POST', /^\/api\/agent\/runs$/, (req, res, m, body) => {
  const prompt = String(body?.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  json(res, 200, agent.startRun(prompt));
});
route('GET', /^\/api\/agent\/runs\/([0-9a-f]+)$/, (req, res, m) => json(res, 200, agent.getRun(m[1])));
route('GET', /^\/api\/agent\/runs\/([0-9a-f]+)\/stream$/, (req, res, m) => agent.streamRun(m[1], res));
route('POST', /^\/api\/agent\/runs\/([0-9a-f]+)\/kill$/, (req, res, m) => {
  agent.killRun(m[1]);
  json(res, 200, { ok: true });
});

// ── Docs (served to the UI and to visiting agents) ──────────────────────
route('GET', /^\/api\/docs$/, (req, res) => {
  const files = ['README.md', 'AGENT.md', ...fs.readdirSync(path.join(repoRoot, 'docs'))
    .filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  json(res, 200, files);
});
route('GET', /^\/api\/docs\/(.+)$/, (req, res, m) => {
  const rel = decodeURIComponent(m[1]);
  const full = path.resolve(repoRoot, rel);
  const allowed = full === path.join(repoRoot, 'README.md')
    || full === path.join(repoRoot, 'AGENT.md')
    || full === path.join(repoRoot, 'AGENTS.md')
    || (full.startsWith(path.join(repoRoot, 'docs') + path.sep) && full.endsWith('.md'));
  if (!allowed || !fs.existsSync(full)) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(fs.readFileSync(full));
});

// ── Static frontend ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let full = path.resolve(distDir, '.' + rel);
  if (!full.startsWith(distDir)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    full = path.join(distDir, 'index.html'); // SPA fallback
    if (!fs.existsSync(full)) {
      return json(res, 503, { error: 'frontend not built — run: npm run frontend:build' });
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
    'Cache-Control': full.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

function readRawBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('upload too large (8MB max)'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid JSON body')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    for (const r of routes) {
      if (req.method !== r.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      if (!r.open) {
        if (!sessionFor(req)) return json(res, 401, { error: 'not authenticated' });
        // Cross-site writes are already blocked by SameSite=Strict; this
        // guards misconfigured proxies.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== url.host) {
          return json(res, 403, { error: 'cross-origin request rejected' });
        }
      }
      const body = r.raw
        ? await readRawBody(req)
        : ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
      return await r.handler(req, res, m, body, url);
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url);
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[manager] listening on http://127.0.0.1:${PORT}`);
});
