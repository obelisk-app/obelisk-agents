// Nostr admin auth, same shape as obelisk-relay's admin panel: the client
// asks for a challenge, signs a kind 22242 event over it (NIP-42 style)
// with any NIP-07/NIP-46 signer, and posts it back. Only pubkeys in
// `adminPubkeys` get a session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyEvent, nip19 } from 'nostr-tools';
import { adminPubkeys, stateDir, SESSION_TTL_MS, CHALLENGE_TTL_MS } from './config.mjs';

const sessionsPath = path.join(stateDir, 'sessions.json');
const challenges = new Map(); // challenge -> issuedAt
let sessions = loadSessions(); // token -> { pubkey, createdAt }

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const now = Date.now();
    return new Map(Object.entries(raw).filter(([, s]) => now - s.createdAt < SESSION_TTL_MS));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  fs.writeFileSync(sessionsPath, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}

export function issueChallenge() {
  const challenge = crypto.randomBytes(32).toString('hex');
  challenges.set(challenge, Date.now());
  // GC stale challenges.
  for (const [c, t] of challenges) if (Date.now() - t > CHALLENGE_TTL_MS) challenges.delete(c);
  return challenge;
}

export function login(event) {
  if (!event || event.kind !== 22242) throw new Error('expected a kind 22242 auth event');
  const challenge = event.tags?.find((t) => t[0] === 'challenge')?.[1];
  if (!challenge || !challenges.has(challenge)) throw new Error('unknown or expired challenge');
  if (Date.now() - challenges.get(challenge) > CHALLENGE_TTL_MS) {
    challenges.delete(challenge);
    throw new Error('challenge expired — try again');
  }
  if (Math.abs(Date.now() / 1000 - event.created_at) > 600) throw new Error('auth event too old');
  if (!verifyEvent(event)) throw new Error('invalid signature');
  if (!adminPubkeys.has(event.pubkey)) {
    throw new Error(`pubkey ${nip19.npubEncode(event.pubkey)} is not an admin`);
  }
  challenges.delete(challenge);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { pubkey: event.pubkey, createdAt: Date.now() });
  saveSessions();
  return token;
}

export function logout(token) {
  if (sessions.delete(token)) saveSessions();
}

export function sessionFor(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)obelisk_manager=([0-9a-f]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) return null;
  return { token: m[1], pubkey: s.pubkey, npub: nip19.npubEncode(s.pubkey) };
}

export function sessionCookie(token, { clear = false } = {}) {
  const base = 'obelisk_manager=' + (clear ? '' : token)
    + '; Path=/; HttpOnly; SameSite=Strict';
  return clear ? base + '; Max-Age=0' : base + `; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
