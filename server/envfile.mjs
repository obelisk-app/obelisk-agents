// Read/write .env.local while preserving comments and line order.
// Secret-looking values (nsec, tokens, keys) are never sent to the client:
// they surface as { secret: true, set: true } and are write-only.
import fs from 'node:fs';
import path from 'node:path';
import { envLocalPath, stateDir } from './config.mjs';

const SECRET_RE = /NSEC|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE/i;
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function isSecretKey(key) {
  return SECRET_RE.test(key);
}

function readLines() {
  try {
    return fs.readFileSync(envLocalPath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

export function readEnvEntries() {
  const entries = [];
  for (const line of readLines()) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, key, raw] = m;
    const value = raw.trim();
    entries.push(
      isSecretKey(key)
        ? { key, secret: true, set: value.length > 0 }
        : { key, secret: false, value },
    );
  }
  return entries;
}

export function readEnvMap() {
  const map = {};
  for (const line of readLines()) {
    const m = line.match(LINE_RE);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

function backup() {
  if (!fs.existsSync(envLocalPath)) return;
  const dir = path.join(stateDir, 'env-backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(envLocalPath, path.join(dir, `env.local.${stamp}`));
  // Keep the newest 50 backups.
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 50))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

// set: { KEY: value }, unset: [KEY]. Existing keys are edited in place;
// new keys are appended under a manager-owned section.
export function applyEnvChanges({ set = {}, unset = [] } = {}) {
  for (const [key, value] of Object.entries(set)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
    if (/[\n\r]/.test(String(value))) throw new Error(`value for ${key} must be a single line`);
  }
  backup();
  const lines = readLines();
  const pending = new Map(Object.entries(set).map(([k, v]) => [k, String(v)]));
  const toUnset = new Set(unset);
  const out = lines.map((line) => {
    const m = line.match(LINE_RE);
    if (!m) return line;
    const key = m[1];
    if (toUnset.has(key)) return `# ${line}`;
    if (pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      return `${key}=${v}`;
    }
    return line;
  });
  if (pending.size > 0) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# ── added via agents.obelisk.ar manager ──');
    for (const [k, v] of pending) out.push(`${k}=${v}`);
  }
  const text = out.join('\n');
  fs.writeFileSync(envLocalPath, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
}
