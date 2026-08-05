// Manager configuration. Everything is overridable from .env.local so the
// manager configures itself with the same env file it manages.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePubkey } from '../lib/secret.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = Number(process.env.MANAGER_PORT) || 3021;

// Sole admin for now: the Obelisk owner npub (same key that owns
// relay.obelisk.ar). Comma-separated MANAGER_ADMIN_NPUBS overrides.
const DEFAULT_ADMIN_NPUBS = [
  'npub1m9vsm9d8sy0pevcjhenwm4ny6l37dm2hsg4dnusna43ql3n5305qy4zlg4',
];

export const adminPubkeys = new Set(
  (process.env.MANAGER_ADMIN_NPUBS
    ? process.env.MANAGER_ADMIN_NPUBS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ADMIN_NPUBS
  ).map(parsePubkey),
);

export const stateDir = path.join(
  process.env.OBELISK_BOTS_STATE_DIR || path.join(repoRoot, 'state'),
  'manager',
);

export const envLocalPath = path.join(repoRoot, '.env.local');
export const ecosystemPath = path.join(repoRoot, 'ecosystem.config.cjs');
export const distDir = path.join(repoRoot, 'frontend', 'dist');

export const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '/root', '.codex');
export const codexAuthPath = path.join(codexHome, 'auth.json');

// Session lifetime: 30 days.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
