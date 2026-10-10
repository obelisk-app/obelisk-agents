#!/usr/bin/env node
// lacrypta-ranks — Nostr/NIP-29 port of La Crypta's Discord ranks bot
// (https://github.com/Negr087/lacrypta-ranks).
//
// A "community" is a relay (e.g. public.obelisk.ar, lacrypta-relay.obelisk.ar);
// its groups are the channels. Each community keeps its own bi-weekly ranking:
//
//   • XP per chat message (kind 9): 100 × min(1, Δt/90s) + random 0–100 bonus
//   • XP per reaction (kind 7): +5 to the reactor (with cooldown), +2 to the author
//   • XP per zap (kind 9735 / ⚡ kind 7): sender +sats/2, receiver +sats,
//     diminishing per pair and cycle (100% → 50% → 25% → 0%)
//   • 22 levels, level-up + Top-3 change announcements
//   • Cycle closes every 14 days (default first close 2026-06-01 17:00 ART):
//     24h / 1h warnings, winners announced, ranking reset
//   • !jurado: 24h community vote (min 5 votes) to cut an abuser's XP
//   • Padrino system: one padrino per member, one ahijado per padrino, no cycles
//
// Commands: see official/lacrypta-ranks.commands.json or `!rangos` in chat.
//
// Config (all optional except the nsec):
//   LACRYPTA_RANKS_NSEC            identity
//   LACRYPTA_RANKS_RELAYS          communities to rank (default: both Obelisk relays)
//   LACRYPTA_RANKS_LISTEN_RELAYS   relays scanned for open groups (default: LACRYPTA_RANKS_RELAYS)
//   LACRYPTA_RANKS_GROUPS          extra static relay|groupId pairs to watch
//   LACRYPTA_RANKS_LEVELS_GROUPS   relay|groupId announcement channel per community
//                             (admins can also set it in chat with !canal-niveles)
//   LACRYPTA_RANKS_ADMINS          npubs allowed to run admin commands (group admins too)
//   LACRYPTA_RANKS_IGNORE_PUBKEYS  extra npubs that never earn XP (every *_NSEC in the
//                             env — i.e. our other bots — is ignored automatically)
//   LACRYPTA_RANKS_FIRST_CLOSE     ISO date of the first cycle close
//   LACRYPTA_RANKS_CYCLE_DAYS      cycle length in days (default 14)
//   LACRYPTA_RANKS_PRIZES          sats for 1st,2nd,3rd (default 5000,3000,1500)
//   LACRYPTA_RANKS_PADRINO_MIN_LEVEL  minimum level to create a padrino profile (default 0)

import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { identityFromEnv, parsePubkey, parseSecret } from '../lib/secret.mjs';
import { createPool, parseGroupList } from '../lib/pool.mjs';
import { advertiseCommands } from '../lib/commands.mjs';
import { hardBreaks } from '../lib/markdown.mjs';
import { createGroupWatcher } from '../lib/group-watcher.mjs';
import { createStateStore } from '../lib/state.mjs';
import { ZAP_KINDS, isZapReaction, tagValue, zapCandidate } from '../lib/zaps.mjs';

const PREFIX = 'lacrypta-ranks';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const RELAYS = list(process.env.LACRYPTA_RANKS_RELAYS
  || 'wss://public.obelisk.ar,wss://lacrypta-relay.obelisk.ar');
const LISTEN_RELAYS = list(process.env.LACRYPTA_RANKS_LISTEN_RELAYS || RELAYS.join(','));
const STATIC_GROUPS = parseGroupList(process.env.LACRYPTA_RANKS_GROUPS);
const LEVELS_GROUPS = parseGroupList(process.env.LACRYPTA_RANKS_LEVELS_GROUPS);
const ADMINS = new Set(list(process.env.LACRYPTA_RANKS_ADMINS
  || 'npub1m9vsm9d8sy0pevcjhenwm4ny6l37dm2hsg4dnusna43ql3n5305qy4zlg4').map(parsePubkey));
const FIRST_CLOSE_MS = Date.parse(process.env.LACRYPTA_RANKS_FIRST_CLOSE || '2026-06-01T20:00:00Z');
const CYCLE_MS = Math.max(1, Number(process.env.LACRYPTA_RANKS_CYCLE_DAYS) || 14) * 24 * 3600_000;
const PRIZES = list(process.env.LACRYPTA_RANKS_PRIZES || '5000,3000,1500').map(Number);
const PADRINO_MIN_LEVEL = Math.max(0, Number(process.env.LACRYPTA_RANKS_PADRINO_MIN_LEVEL) || 0);
const REFRESH_MS = Math.max(60_000, Number(process.env.LACRYPTA_RANKS_REFRESH_MS) || 600_000);
const TICK_MS = 30_000;

// ── XP rules (same numbers as the Discord bot) ──────────────────────
const COOLDOWN_MS = 90_000;
const XP_MESSAGE = 100;
const XP_REACTION_RECEIVE = 2;
const XP_REACTION_SEND = 5;
// XP needed to go from level n-1 to level n (index 0 = level 1).
const LEVELS = [100, 1000, 3000, ...Array.from({ length: 18 }, (_, i) => (i + 4) * 1000), 100000];
const JURY_MS = 24 * 3600_000;
const JURY_MIN_VOTES = 5;
const JURY_PENALTIES = [0, 25, 50, 75, 100];
const ZAP_MULTIPLIERS = [1, 0.5, 0.25];
const MEDALS = ['🥇', '🥈', '🥉'];

function levelFromTotal(total) {
  let level = 0;
  let acc = 0;
  for (const need of LEVELS) {
    if (acc + need > total) break;
    acc += need;
    level += 1;
  }
  return { level, inLevel: total - acc, toNext: LEVELS[level] != null ? LEVELS[level] - (total - acc) : null };
}

function messageXp(length, deltaMs) {
  const timeFactor = Math.min(1, Math.max(0, deltaMs) / COOLDOWN_MS);
  return Math.floor(XP_MESSAGE * timeFactor + XP_MESSAGE * ((Math.random() * length) % 1));
}

// ── Cycle math ──────────────────────────────────────────────────────
const closesPassed = (now = Date.now()) =>
  now < FIRST_CLOSE_MS ? 0 : Math.floor((now - FIRST_CLOSE_MS) / CYCLE_MS) + 1;
const nextClose = (now = Date.now()) => FIRST_CLOSE_MS + closesPassed(now) * CYCLE_MS;
const cycleStart = (now = Date.now()) => nextClose(now) - CYCLE_MS;
const fmtDate = (ms) => new Date(ms).toLocaleString('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
function fmtRemaining(ms) {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${d}d ${h}h ${m}m`;
}

// ── Mentions ────────────────────────────────────────────────────────
const mention = (pk) => `nostr:${nip19.npubEncode(pk)}`;
function mentionedPubkeys(content) {
  const out = [];
  for (const m of String(content).matchAll(/(?:nostr:)?(npub1[02-9ac-hj-np-z]{58})/g)) {
    try { out.push(nip19.decode(m[1]).data); } catch {}
  }
  for (const m of String(content).matchAll(/nostr:(nprofile1[02-9ac-hj-np-z]+)/g)) {
    try { out.push(nip19.decode(m[1]).data.pubkey); } catch {}
  }
  return out;
}

const HELP = [
  '🏆 **Bot de Rangos** — comandos:',
  '`!ranking` top 10 del ciclo · `!milugar` tu posición · `!perfil [@usuario]`',
  '`!xpinfo` cómo se calcula el XP · `!cierre` cuándo cierra el ciclo',
  '`!fbi @usuario` reporte de actividad del ciclo',
  '`!jurado @usuario <0|25|50|75|100> [motivo]` iniciar votación · `!jurado` ver activas',
  '`!votar si|no [@acusado]` (o reaccioná 👍/👎 al mensaje del jurado)',
  '`!ser-padrino <resumen> | <biografía>` · `!obtener-padrino` · `!mi-ahijado` · `!infopadrino`',
  'Admins: `!canal-niveles [off]` · `!reset-niveles`',
].join('\n');

const XPINFO = [
  '⚙️ **Configuración del sistema de XP**',
  '',
  `💬 **Por mensaje:** base ${XP_MESSAGE} XP multiplicado por el tiempo desde tu último mensaje (cooldown de ${COOLDOWN_MS / 1000}s), más un bonus aleatorio de 0 a 100 XP. Total posible: 0 a 200 XP.`,
  '⚡ **Por enviar un zap:** la mitad de los sats en XP (100 sats → 50 XP).',
  '⚡ **Por recibir un zap:** los mismos sats en XP (100 sats → 100 XP).',
  '🛡️ **Anti-abuso de zaps** (mismo par de usuarios, por ciclo): 1° 100% · 2° 50% · 3° 25% · 4° en adelante 0%.',
  `❤️ **Por recibir una reacción:** ${XP_REACTION_RECEIVE} XP.`,
  `👍 **Por reaccionar a mensajes de otros:** ${XP_REACTION_SEND} XP (con cooldown).`,
  `📊 **XP por nivel:** nivel 1: ${LEVELS[0]} · nivel 2: ${LEVELS[1]} · nivel 3: ${LEVELS[2]} · niveles 4–21: +1000 cada uno · nivel 22 (máximo): ${LEVELS[21]}.`,
  `🏆 **Premios quincenales:** ${PRIZES.map((p, i) => `${MEDALS[i]} ${p} sats`).join(' · ')}`,
  `⚖️ **Jurado:** cualquiera puede iniciar una votación con \`!jurado\`. Dura 24 h fijas, necesita mínimo ${JURY_MIN_VOTES} votos; si no llega, el acusado sale INOCENTE; si gana "a favor" con quórum se aplica la penalización.`,
  '',
  'Cada 2 semanas se reinicia el ranking y se reparten premios.',
].join('\n');

const INFOPADRINO = [
  '🤝 **Sistema de Padrinos — cómo funciona**',
  'Es una cadena de confianza: cada miembro tiene un único padrino y cada padrino apadrina a una única persona. Las cadenas no pueden formar ciclos.',
  '',
  '1️⃣ **Ser padrino:** `!ser-padrino <resumen> | <biografía>` crea (o edita) tu perfil de padrino.',
  '2️⃣ **Elegir padrino:** `!obtener-padrino` lista los disponibles (sin ahijado y sin generar ciclos). Después `!obtener-padrino @padrino` para ver su perfil y `!obtener-padrino @padrino confirmar` para elegirlo.',
  '3️⃣ **Ver tu ahijado:** `!mi-ahijado`.',
  '',
  '📏 **Reglas:** 1 padrino por persona · 1 ahijado por padrino · sin garantías recíprocas (si A es padrino de B, B no puede serlo de A) · sin ciclos (A→B→A ni A→B→C→A) · la elección no se puede cambiar libremente (regla 11).',
  '🔗 **Estructura:** `A → B → C → D` — cada flecha significa "es padrino de".',
  '💬 **Responsabilidad:** el padrino responde por la incorporación de su ahijado; los incumplimientos pueden comunicarse al padrino.',
].join('\n');

async function main() {
  const nsecEnv = process.env.LACRYPTA_RANKS_NSEC ? 'LACRYPTA_RANKS_NSEC' : 'BOT_NSEC';
  const { sk, pk, npub } = identityFromEnv(nsecEnv);
  const pool = createPool(sk);
  const commandList = advertiseCommands({ pool, sk, relays: [...RELAYS, ...STATIC_GROUPS.map((g) => g.relay), ...LISTEN_RELAYS], script: import.meta.url });
  const { loadState, saveState, statePath } = createStateStore({
    fileName: 'obelisk-lacrypta-ranks-state.json',
    envName: 'LACRYPTA_RANKS_STATE_PATH',
    logPrefix: PREFIX,
  });

  // Our own bots never earn XP: derive their pubkeys from every *_NSEC in env.
  const ignored = new Set([pk, ...list(process.env.LACRYPTA_RANKS_IGNORE_PUBKEYS).map(parsePubkey)]);
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.endsWith('_NSEC') || !v) continue;
    try { ignored.add(getPublicKey(parseSecret(v))); } catch {}
  }

  const state = loadState();
  state.communities ||= {};
  state.cursors ||= {};
  state.joined ||= {};
  if (state.closesDone == null) state.closesDone = closesPassed();
  state.warned ||= {};
  const seen = new Set(state.seen || []);
  const rememberSeen = (id) => {
    seen.add(id);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
  };

  let saveTimer = null;
  const persist = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      state.seen = [...seen].slice(-3_000);
      saveState(state);
    }, 3_000);
  };

  const communityKey = (relay) => relay.replace(/\/+$/, '');
  function community(relay) {
    const c = (state.communities[communityKey(relay)] ||= {});
    c.members ||= {};
    c.log ||= [];
    c.juries ||= [];
    c.zapPairs ||= {};
    return c;
  }
  const member = (c, who) => (c.members[who] ||= { xp: 0, lastAt: 0, padrino: null, profile: null });
  for (const g of LEVELS_GROUPS) community(g.relay).levelsGroup ||= g.groupId;

  const groupNames = new Map(); // relay|groupId → name
  const messageAuthors = new Map(); // event id → pubkey (for reactions without p tag)

  console.log(`[${PREFIX}] running as ${npub}`);
  console.log(`[${PREFIX}] communities: ${RELAYS.join(', ')}`);
  console.log(`[${PREFIX}] listen relays: ${LISTEN_RELAYS.join(', ') || '(none)'}`);
  console.log(`[${PREFIX}] ignoring ${ignored.size} bot pubkeys; admins: ${ADMINS.size}`);
  console.log(`[${PREFIX}] state: ${statePath}`);
  console.log(`[${PREFIX}] next close: ${fmtDate(nextClose())}`);

  // ── Publishing ──────────────────────────────────────────────────
  async function post(relay, groupId, content, reply = null) {
    const tags = [['h', groupId]];
    if (reply) tags.push(['e', reply.id]);
    const ps = new Set([...(reply ? [reply.pubkey] : []), ...mentionedPubkeys(content)]);
    ps.delete(pk);
    for (const p of ps) tags.push(['p', p]);
    const ev = finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000), tags, content: hardBreaks(content) }, sk);
    try {
      await Promise.any(pool.publish([relay], ev));
      return ev;
    } catch (err) {
      const key = `${relay}|${groupId}`;
      if (!state.joined[key]) {
        // Open groups may still want a join request before accepting posts.
        const join = finalizeEvent({ kind: 9021, created_at: Math.floor(Date.now() / 1000), tags: [['h', groupId]], content: '' }, sk);
        try {
          await Promise.any(pool.publish([relay], join));
          state.joined[key] = Math.floor(Date.now() / 1000);
          persist();
          await Promise.any(pool.publish([relay], ev));
          return ev;
        } catch {}
      }
      console.warn(`[${PREFIX}] post failed ${relay} ${groupId.slice(0, 8)}: ${err?.errors?.[0]?.message || err?.message || err}`);
      return null;
    }
  }

  const announceGroup = (relay, originGroup) => community(relay).levelsGroup || originGroup;

  // ── Ranking helpers ─────────────────────────────────────────────
  const ranking = (c) => Object.entries(c.members)
    .filter(([, m]) => m.xp > 0)
    .sort((a, b) => b[1].xp - a[1].xp);
  const top3 = (c) => ranking(c).slice(0, 3).map(([who]) => who);

  function addXp(relay, who, amount, { groupId, ts = Date.now(), touch = false, pair } = {}) {
    const c = community(relay);
    const m = member(c, who);
    const before = levelFromTotal(m.xp).level;
    if (amount > 0) {
      m.xp += amount;
      c.log.push({ pk: who, g: groupId, xp: amount, ts, ...(pair ? { pair } : {}) });
    }
    if (touch) m.lastAt = Math.max(m.lastAt || 0, ts);
    persist();
    const after = levelFromTotal(m.xp).level;
    return { gained: amount, level: after, leveledUp: after > before };
  }

  // Run fn (which mutates XP) and announce Top-3 changes, like the Discord bot.
  async function withTop3(relay, groupId, actor, fn, header = '🏆 **¡Hubo cambios en el Top 3!**') {
    const c = community(relay);
    const before = top3(c);
    const result = await fn();
    const afterFull = ranking(c).slice(0, 3);
    const after = afterFull.map(([who]) => who);
    const changed = after.some((who, i) => who !== before[i]);
    const leaderLevel = afterFull[0] ? levelFromTotal(afterFull[0][1].xp).level : 0;
    if (changed && after.length && leaderLevel >= 5) {
      let msg = `${header}\n${after.map((who, i) => `${MEDALS[i]} ${mention(who)}`).join('\n')}`;
      const pos = actor ? after.indexOf(actor) : -1;
      const destroyed = pos !== -1 && pos < before.length ? before[pos] : null;
      if (destroyed && destroyed !== actor) msg += `\n\n💥 ${mention(destroyed)} ¡fuiste destruido!`;
      await post(relay, announceGroup(relay, groupId), msg);
    }
    return result;
  }

  // ── Event handlers ──────────────────────────────────────────────
  async function onMessage(relay, groupId, ev) {
    messageAuthors.set(ev.id, ev.pubkey);
    if (messageAuthors.size > 20_000) messageAuthors.delete(messageAuthors.keys().next().value);
    const text = ev.content.trim();
    if (text.startsWith('!')) {
      const word = text.split(/\s+/)[0].toLowerCase();
      if (COMMANDS[word]) return runCommand(relay, groupId, ev, word, text.slice(word.length).trim());
    }
    if (ignored.has(ev.pubkey)) return;
    const c = community(relay);
    const m = member(c, ev.pubkey);
    const ts = Math.min(ev.created_at * 1000, Date.now());
    const xp = messageXp(ev.content.length, ts - (m.lastAt || 0));
    await withTop3(relay, groupId, ev.pubkey, async () => {
      const r = addXp(relay, ev.pubkey, xp, { groupId, ts, touch: true });
      if (r.leveledUp) {
        await post(relay, announceGroup(relay, groupId), `Felicitaciones ${mention(ev.pubkey)}! subiste al nivel ${r.level}!`);
      }
    });
  }

  const reactionsDone = new Set();
  async function onReaction(relay, groupId, ev) {
    const target = tagValue(ev.tags.filter((t) => t[0] === 'e').slice(-1), 'e');
    if (!target) return;
    const c = community(relay);

    const jury = c.juries.find((j) => j.status === 'active' && j.eventId === target);
    if (jury) {
      const vote = /^(\+|👍|✅)/u.test(ev.content) ? 'for' : /^(-|👎|❌)/u.test(ev.content) ? 'against' : null;
      if (vote && ev.pubkey !== jury.accused && !ignored.has(ev.pubkey) && jury.votes[ev.pubkey] !== vote) {
        jury.votes[ev.pubkey] = vote;
        persist();
        console.log(`[${PREFIX}] jury ${jury.id} vote ${vote} by ${ev.pubkey.slice(0, 8)}`);
        announceTally(relay, jury);
      }
      return;
    }

    const author = messageAuthors.get(target) || tagValue(ev.tags.filter((t) => t[0] === 'p').slice(-1), 'p');
    if (!author || author === ev.pubkey || ignored.has(author) || ignored.has(ev.pubkey)) return;
    const key = `${target}|${ev.content}|${ev.pubkey}`;
    if (reactionsDone.has(key)) return;
    reactionsDone.add(key);
    if (reactionsDone.size > 20_000) reactionsDone.delete(reactionsDone.values().next().value);

    const reactor = member(c, ev.pubkey);
    const ts = Math.min(ev.created_at * 1000, Date.now());
    const sendXp = Math.floor(XP_REACTION_SEND * Math.min(1, Math.max(0, ts - (reactor.lastAt || 0)) / COOLDOWN_MS));
    await withTop3(relay, groupId, ev.pubkey, async () => {
      const r1 = addXp(relay, ev.pubkey, sendXp, { groupId, ts, touch: true });
      const r2 = addXp(relay, author, XP_REACTION_RECEIVE, { groupId, ts });
      const dest = announceGroup(relay, groupId);
      if (r1.leveledUp) await post(relay, dest, `Felicitaciones ${mention(ev.pubkey)}! subiste al nivel ${r1.level}!`);
      if (r2.leveledUp) await post(relay, dest, `Felicitaciones ${mention(author)}! subiste al nivel ${r2.level}!`);
    });
  }

  // A zap can arrive both as a ⚡ reaction and a 9735 receipt — count it once.
  const recentZaps = new Map();
  async function onZap(relay, groupId, ev) {
    const zap = zapCandidate(ev);
    if (!zap || !zap.groupIds.includes(groupId)) return;
    const { senderHex: sender, recipient, sats } = zap;
    if (!sender || !recipient || !sats || sender === recipient) return;
    if (ignored.has(sender) || ignored.has(recipient)) return;
    const dedupeKey = `${sender}|${recipient}|${zap.eTag || ''}|${sats}`;
    const now = Date.now();
    for (const [k, t] of recentZaps) if (now - t > 15 * 60_000) recentZaps.delete(k);
    if (recentZaps.has(dedupeKey)) return;
    recentZaps.set(dedupeKey, now);

    const c = community(relay);
    const pairKey = [sender, recipient].sort().join('|');
    const previous = c.zapPairs[pairKey] || 0;
    c.zapPairs[pairKey] = previous + 1;
    const multiplier = ZAP_MULTIPLIERS[previous] ?? 0;
    const label = `${multiplier * 100}%`;
    const dest = announceGroup(relay, groupId);
    console.log(`[${PREFIX}] zap ${sender.slice(0, 8)} -> ${recipient.slice(0, 8)} ${sats} sats (#${previous + 1}, ${label})`);

    if (multiplier === 0) {
      persist();
      await post(relay, dest, `⚡ Zap entre ${mention(sender)} y ${mention(recipient)} registrado pero no suma XP (ya alcanzaron el límite de zaps entre ustedes en este ciclo).`);
      return;
    }
    const ts = Math.min(ev.created_at * 1000, now);
    await withTop3(relay, groupId, sender, async () => {
      const s = addXp(relay, sender, Math.floor((sats / 2) * multiplier), { groupId, ts, pair: recipient });
      const r = addXp(relay, recipient, Math.floor(sats * multiplier), { groupId, ts, pair: sender });
      if (previous > 0) {
        await post(relay, dest, `⚡ Zap registrado entre ${mention(sender)} y ${mention(recipient)} — XP reducido al ${label} (${previous + 1}° zap entre ellos en el ciclo).`);
      }
      if (s.leveledUp) await post(relay, dest, `⚡ Felicitaciones ${mention(sender)}! subiste al nivel ${s.level} por enviar un zap!`);
      if (r.leveledUp) await post(relay, dest, `⚡ Felicitaciones ${mention(recipient)}! subiste al nivel ${r.level} por recibir un zap!`);
    });
  }

  // ── Admin check: configured admins or admins of this group (kind 39001) ──
  function isGroupAdmin(relay, groupId, who) {
    return new Promise((resolve) => {
      let found = false;
      let sub;
      const done = () => { try { sub?.close(); } catch {} resolve(found); };
      sub = pool.subscribe([relay], { kinds: [39001], '#d': [groupId] }, {
        onauth: async () => null,
        onevent: (ev) => { if (ev.tags.some((t) => t[0] === 'p' && t[1] === who)) found = true; },
        oneose: done,
        onclose: done,
      });
      setTimeout(done, 5_000);
    });
  }
  const isAdmin = async (relay, groupId, who) => ADMINS.has(who) || isGroupAdmin(relay, groupId, who);

  // Target of a command: first npub in the text, else the replied-to author.
  const targetOf = (ev, args) => mentionedPubkeys(args)[0]
    || ev.tags.find((t) => t[0] === 'p' && t[1] !== pk && t[1] !== ev.pubkey)?.[1]
    || null;

  // ── Jury ────────────────────────────────────────────────────────
  function juryText(j) {
    const votes = Object.values(j.votes);
    const forN = votes.filter((v) => v === 'for').length;
    const againstN = votes.length - forN;
    const missing = Math.max(0, JURY_MIN_VOTES - votes.length);
    const left = Math.max(0, j.expiresAt - Date.now());
    return `⚖️ **Votación de Jurado** (#${j.id})\n`
      + `**Acusado:** ${mention(j.accused)}\n`
      + `**Iniciado por:** ${mention(j.initiator)}\n`
      + `**Penalización propuesta:** ${j.penalty === 0 ? 'Sin penalización (advertencia)' : `restar **${j.penalty}%** del XP total`}\n`
      + (j.reason ? `**Motivo:** ${j.reason}\n` : '')
      + `\n👍 A favor: **${forN}** · 👎 En contra: **${againstN}**\n`
      + `🗳️ Quórum: **${votes.length}/${JURY_MIN_VOTES}**${missing && j.status === 'active' ? ` (faltan ${missing})` : ''}\n`
      + (j.status === 'active' ? `⏰ ${Math.floor(left / 3_600_000)}h ${Math.floor((left % 3_600_000) / 60_000)}m restantes` : '⏰ CERRADA');
  }

  // Reaction votes are silent otherwise; reply with the tally, batched so a
  // burst of reactions yields one message. No mentions, so nobody gets pinged.
  const tallyTimers = new Map();
  function announceTally(relay, j) {
    if (tallyTimers.has(j.id)) return;
    tallyTimers.set(j.id, setTimeout(async () => {
      tallyTimers.delete(j.id);
      if (j.status !== 'active') return;
      const votes = Object.values(j.votes);
      const forN = votes.filter((v) => v === 'for').length;
      const missing = Math.max(0, JURY_MIN_VOTES - votes.length);
      await post(relay, j.group, `🗳️ Jurado #${j.id}: 👍 **${forN}** · 👎 **${votes.length - forN}** · quórum **${votes.length}/${JURY_MIN_VOTES}**${missing ? ` (faltan ${missing})` : ''}`,
        j.eventId ? { id: j.eventId, pubkey: pk } : null);
    }, 30_000));
  }

  async function closeJury(relay, j) {
    const c = community(relay);
    const votes = Object.values(j.votes);
    const forN = votes.filter((v) => v === 'for').length;
    j.status = 'closed';
    j.closedAt = Date.now();
    if (votes.length < JURY_MIN_VOTES) {
      j.result = 'no_quorum';
      persist();
      await post(relay, j.group, `⚖️ **Veredicto:** ${mention(j.accused)} sale **INOCENTE**.\nLa votación no alcanzó el mínimo de ${JURY_MIN_VOTES} votos (solo hubo ${votes.length}).`);
      return;
    }
    const approved = forN > votes.length - forN;
    j.result = approved ? 'approved' : 'rejected';
    persist();
    if (!approved) {
      await post(relay, j.group, `⚖️ **Veredicto:** la votación contra ${mention(j.accused)} fue **rechazada**. No hubo mayoría a favor.`);
      return;
    }
    if (j.penalty === 0) {
      await post(relay, j.group, `⚖️ **Veredicto:** la votación contra ${mention(j.accused)} fue aprobada pero la penalización es 0% (advertencia, sin efecto en el XP).`);
      return;
    }
    await withTop3(relay, j.group, null, async () => {
      const m = member(c, j.accused);
      const before = { xp: m.xp, level: levelFromTotal(m.xp).level };
      m.xp = Math.max(0, Math.floor(m.xp * (1 - j.penalty / 100)));
      persist();
      await post(relay, j.group, `⚖️ **Veredicto:** ${mention(j.accused)} fue **CONDENADO** por la votación.\n`
        + `Penalización: -${j.penalty}% del XP total.\n`
        + `XP antes: ${before.xp} → XP después: ${m.xp}\n`
        + `Nivel: ${before.level} → ${levelFromTotal(m.xp).level}`);
    }, '🏆 **¡Cambios en el Top 3 tras el veredicto del jurado!**');
  }

  // ── Padrinos ────────────────────────────────────────────────────
  // Would making `padrino` the padrino of `who` close a loop?
  function wouldCycle(c, who, padrino) {
    const visited = new Set();
    for (let cur = padrino; cur && !visited.has(cur); cur = c.members[cur]?.padrino) {
      if (cur === who) return true;
      visited.add(cur);
    }
    return false;
  }
  const ahijadoOf = (c, padrino) => Object.entries(c.members).find(([, m]) => m.padrino === padrino)?.[0] || null;
  const availablePadrinos = (c, who) => Object.entries(c.members)
    .filter(([p, m]) => m.profile && p !== who && !ahijadoOf(c, p) && !wouldCycle(c, who, p))
    .map(([p]) => p);

  // ── Commands ────────────────────────────────────────────────────
  const COMMANDS = {
    '!ping': () => 'pong 🏓',
    '!rangos': () => HELP,
    '!ranks': () => HELP,
    '!xpinfo': () => XPINFO,
    '!infopadrino': () => INFOPADRINO,
    '!cierre': () => `📅 Próximo cierre del ranking: **${fmtDate(nextClose())}** (faltan ${fmtRemaining(nextClose() - Date.now())}).`,

    '!ranking': ({ c }) => {
      const top = ranking(c).slice(0, 10);
      if (!top.length) return '# Ranking de niveles\nNadie ganó experiencia todavía en este ciclo.';
      const label = (i) => ['🏆 Primero', '🥈 Segundo', '🥉 Tercero'][i] || `#${i + 1}`;
      return `# Ranking de niveles\n${top.map(([who, m], i) =>
        `${label(i)} — ${mention(who)} · Nivel ${levelFromTotal(m.xp).level} · XP ${m.xp}`).join('\n')}`;
    },

    '!milugar': ({ c, ev }) => {
      const all = ranking(c);
      const pos = all.findIndex(([who]) => who === ev.pubkey);
      if (pos === -1) return 'Todavía no estás en el ranking. ¡Empezá a participar para sumar XP!';
      const me = all[pos][1];
      const lv = levelFromTotal(me.xp);
      let msg = `📊 **Tu lugar en el ranking**\n\n🏅 Posición: **#${pos + 1}** de ${all.length}\n`
        + `⭐ Nivel actual: **${lv.level}**\n✨ XP en el nivel: **${lv.inLevel}** (total ${me.xp})\n`;
      msg += lv.toNext != null ? `📈 Te faltan **${lv.toNext} XP** para el nivel ${lv.level + 1}\n` : '🌟 ¡Llegaste al nivel máximo!\n';
      if (pos === 0) return `${msg}\n👑 ¡Estás en el **primer puesto**!`;
      const [aboveWho, above] = all[pos - 1];
      const aboveLevel = levelFromTotal(above.xp).level;
      return `${msg}\n🎯 Te faltan **${above.xp - me.xp} XP** para alcanzar a ${mention(aboveWho)}${aboveLevel !== lv.level ? ` (Nivel ${aboveLevel})` : ''}`;
    },

    '!perfil': ({ c, ev, args }) => {
      const who = targetOf(ev, args) || ev.pubkey;
      const m = c.members[who];
      if (!m) return 'No se encontró el perfil (todavía no tiene actividad registrada).';
      const lv = levelFromTotal(m.xp);
      const ahijado = ahijadoOf(c, who);
      const own = who === ev.pubkey;
      return `# ${own ? 'Tu' : 'Su'} perfil\n${mention(who)}\n`
        + `⭐ Nivel: **${lv.level}** · ✨ XP: **${m.xp}**\n`
        + `🤝 ${own ? 'Tu' : 'Su'} padrino: ${m.padrino ? mention(m.padrino) : 'Sin padrino'}\n`
        + `👶 ${own ? 'Tus' : 'Sus'} ahijados: ${m.profile ? (ahijado ? mention(ahijado) : 'Sin ahijados') : 'Sin ahijados'}`;
    },

    '!fbi': ({ c, relay, ev, args }) => {
      const who = targetOf(ev, args);
      if (!who) return 'Uso: `!fbi @usuario`';
      const m = c.members[who];
      if (!m) return `${mention(who)} no tiene actividad registrada.`;
      const start = cycleStart();
      const logs = c.log.filter((l) => l.pk === who && l.ts >= start);
      if (!logs.length) return `🔍 No hay actividad registrada de ${mention(who)} en este ciclo.`;
      const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const byGroup = {};
      const byHour = {};
      for (const l of logs) {
        byGroup[l.g] = (byGroup[l.g] || 0) + 1;
        const h = (new Date(l.ts).getUTCHours() + 21) % 24; // ART = UTC-3
        byHour[h] = (byHour[h] || 0) + 1;
      }
      const [g, gN] = top(byGroup);
      const [h, hN] = top(byHour);
      const hh = (n) => String(n).padStart(2, '0');
      return `🕵️ **FBI Report:** ${mention(who)}\nActividad del ciclo actual (desde ${fmtDate(start)})\n\n`
        + `💬 Total de eventos con XP: **${logs.length}**\n✨ XP sumado: **${logs.reduce((s, l) => s + l.xp, 0)}**\n`
        + `⭐ Nivel actual: **${levelFromTotal(m.xp).level}**\n`
        + `📍 Canal más usado: **${groupNames.get(`${relay}|${g}`) || g}** (${gN})\n`
        + `🕐 Hora pico (AR): **${hh(h)}:00 - ${hh((Number(h) + 1) % 24)}:00** (${hN})`;
    },

    '!jurado': async ({ c, relay, groupId, ev, args }) => {
      const active = c.juries.filter((j) => j.status === 'active');
      if (!args) {
        return active.length
          ? active.map(juryText).join('\n\n———\n\n')
          : 'No hay votaciones activas.\nUso: `!jurado @usuario <0|25|50|75|100> [motivo]`';
      }
      const accused = targetOf(ev, args);
      const rest = args.replace(/(?:nostr:)?(?:npub1|nprofile1)[02-9ac-hj-np-z]+/g, '').trim();
      const penalty = Number(rest.match(/^(\d+)%?/)?.[1]);
      const reason = rest.replace(/^\d+%?\s*/, '').slice(0, 300) || null;
      if (!accused || !JURY_PENALTIES.includes(penalty)) {
        return 'Uso: `!jurado @usuario <0|25|50|75|100> [motivo]` — la penalización es el % de XP a restar si gana la condena.';
      }
      if (accused === ev.pubkey) return 'No podés iniciar una votación contra vos mismo.';
      if (ignored.has(accused)) return 'No podés iniciar una votación contra un bot.';
      if (active.some((j) => j.accused === accused)) return `Ya hay una votación activa contra ${mention(accused)}. Esperá a que se cierre.`;
      const j = {
        id: Math.random().toString(16).slice(2, 8),
        group: groupId,
        initiator: ev.pubkey,
        accused,
        penalty,
        reason,
        createdAt: Date.now(),
        expiresAt: Date.now() + JURY_MS,
        votes: {},
        status: 'active',
      };
      c.juries.push(j);
      persist();
      const sent = await post(relay, groupId, `${juryText(j)}\n\nVotá reaccionando 👍 (a favor) o 👎 (en contra) a este mensaje, o con \`!votar si|no ${mention(accused)}\`.`, ev);
      j.eventId = sent?.id || null;
      persist();
      return null;
    },

    '!votar': ({ c, ev, args }) => {
      const vote = /^(si|sí|yes|a\s*favor|\+|👍)/iu.test(args) ? 'for' : /^(no|en\s*contra|-|👎)/iu.test(args) ? 'against' : null;
      if (!vote) return 'Uso: `!votar si|no [@acusado]`';
      const active = c.juries.filter((j) => j.status === 'active');
      const replyTo = ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
      const target = mentionedPubkeys(args)[0];
      const j = active.find((x) => replyTo.includes(x.eventId))
        || (target && active.find((x) => x.accused === target))
        || (active.length === 1 ? active[0] : null);
      if (!j) return active.length ? 'Hay varias votaciones activas: indicá el acusado, `!votar si|no @acusado`.' : 'No hay votaciones activas.';
      if (j.accused === ev.pubkey) return 'No podés votar en tu propio jurado.';
      j.votes[ev.pubkey] = vote;
      persist();
      return `🗳️ Voto registrado (${vote === 'for' ? '👍 a favor' : '👎 en contra'}).\n\n${juryText(j)}`;
    },

    '!ser-padrino': ({ c, ev, args }) => {
      const [short, ...bio] = args.split('|');
      if (!short?.trim() || !bio.join('|').trim()) {
        return 'Uso: `!ser-padrino <resumen> | <biografía>`\nEj: `!ser-padrino Dev de Lightning | Hace 5 años que construyo en Bitcoin…`';
      }
      const m = member(c, ev.pubkey);
      if (levelFromTotal(m.xp).level < PADRINO_MIN_LEVEL) return `Necesitás nivel ${PADRINO_MIN_LEVEL} para ser padrino.`;
      m.profile = { short: short.trim().slice(0, 150), long: bio.join('|').trim().slice(0, 1024) };
      persist();
      return `# Tu perfil de Padrino ✅\n${mention(ev.pubkey)}\n**Resumen:** ${m.profile.short}\n**Biografía:** ${m.profile.long}\n\nPodés editarlo volviendo a usar \`!ser-padrino\`.`;
    },

    '!obtener-padrino': ({ c, ev, args }) => {
      const me = member(c, ev.pubkey);
      if (me.padrino) return `Ya tenés un padrino asignado: ${mention(me.padrino)}.\nNo se puede cambiar libremente (regla 11 del reglamento).`;
      const available = availablePadrinos(c, ev.pubkey);
      const chosen = mentionedPubkeys(args)[0];
      if (!chosen) {
        if (!available.length) {
          return 'No hay padrinos disponibles en este momento.\nPuede pasar porque todos ya tienen un ahijado, o porque no se puede armar una cadena válida sin generar ciclos.';
        }
        return `# Padrinos disponibles\n${available.map((p) => `• ${mention(p)} — ${c.members[p].profile.short}`).join('\n')}\n\n`
          + 'Mirá un perfil con `!obtener-padrino @padrino` y confirmá con `!obtener-padrino @padrino confirmar`.';
      }
      if (!available.includes(chosen)) return 'Ese padrino no está disponible (no tiene perfil, ya tiene ahijado o se formaría un ciclo). Usá `!obtener-padrino` para ver la lista.';
      const profile = c.members[chosen].profile;
      if (!/\bconfirmar\b/i.test(args)) {
        return `# Confirmá tu padrino\n${mention(chosen)}\n**Resumen:** ${profile.short}\n**Biografía:** ${profile.long}\n\n`
          + `Para confirmar: \`!obtener-padrino ${mention(chosen)} confirmar\``;
      }
      me.padrino = chosen;
      persist();
      return `# ¡Padrino confirmado! ✅\n${mention(chosen)} es ahora tu padrino.`;
    },

    '!mi-ahijado': ({ c, ev }) => {
      const m = c.members[ev.pubkey];
      if (!m?.profile) return 'Todavía no tenés perfil de padrino. Usá `!ser-padrino` para crearlo.';
      const ahijado = ahijadoOf(c, ev.pubkey);
      if (!ahijado) return 'Tenés perfil de padrino pero todavía no apadrinaste a nadie.\nPodés apadrinar a **1** persona (regla 3 del reglamento).';
      return `🤝 **Tu ahijado:** ${mention(ahijado)} · Nivel actual ${levelFromTotal(c.members[ahijado].xp).level}\nRecordá que sos responsable de su incorporación a la comunidad.`;
    },

    '!canal-niveles': async ({ c, relay, groupId, ev, args }) => {
      if (!(await isAdmin(relay, groupId, ev.pubkey))) return 'No tenés permisos para usar este comando.';
      if (/^off$/i.test(args)) {
        c.levelsGroup = null;
        persist();
        return 'Canal de niveles desactivado: los anuncios van al grupo donde ocurren.';
      }
      c.levelsGroup = groupId;
      persist();
      return '✅ Este grupo es ahora el canal de niveles: acá van los level-ups, cambios del Top 3, avisos y cierre del ranking.';
    },

    '!reset-niveles': async ({ c, relay, groupId, ev }) => {
      if (!(await isAdmin(relay, groupId, ev.pubkey))) return 'No tenés permisos para usar este comando.';
      resetCommunity(c);
      return 'Se resetearon los niveles correctamente.';
    },
  };
  COMMANDS['!ranking-niveles'] = COMMANDS['!ranking'];
  COMMANDS['!ver-perfil'] = COMMANDS['!perfil'];
  COMMANDS['!reset-levels'] = COMMANDS['!reset-niveles'];
  COMMANDS['!set-levels-channel'] = COMMANDS['!canal-niveles'];

  const lastCommand = new Map();
  async function runCommand(relay, groupId, ev, word, args) {
    const throttleKey = `${relay}|${groupId}|${ev.pubkey}|${word}`;
    if (Date.now() - (lastCommand.get(throttleKey) || 0) < 3_000) return;
    lastCommand.set(throttleKey, Date.now());
    let reply;
    try {
      reply = await COMMANDS[word]({ c: community(relay), relay, groupId, ev, args });
    } catch (err) {
      console.warn(`[${PREFIX}] ${word} failed:`, err?.message || err);
      reply = 'Hubo un error al ejecutar el comando.';
    }
    if (reply) await post(relay, groupId, reply, ev);
  }

  function resetCommunity(c) {
    for (const m of Object.values(c.members)) {
      m.xp = 0;
      m.lastAt = 0;
    }
    c.log = [];
    c.zapPairs = {};
    persist();
  }

  // ── Cycle scheduler + jury expiry ───────────────────────────────
  async function tick() {
    const now = Date.now();
    for (const relay of RELAYS) {
      for (const j of community(relay).juries) {
        if (j.status === 'active' && j.expiresAt <= now) await closeJury(relay, j);
      }
      const c = community(relay);
      c.juries = c.juries.filter((j) => j.status === 'active' || now - j.closedAt < 30 * 86_400_000);
    }

    const close = nextClose(now);
    const remaining = close - now;
    const broadcast = async (text) => {
      for (const relay of RELAYS) {
        const g = community(relay).levelsGroup;
        if (g) await post(relay, g, text);
        else console.log(`[${PREFIX}] no levels group for ${relay}; skipped announcement`);
      }
    };
    if (state.warned.h24 !== close && remaining <= 24 * 3_600_000 && remaining > 23 * 3_600_000) {
      state.warned.h24 = close;
      persist();
      await broadcast(`⏰ **¡Atención!** Quedan **24 horas** para el cierre del ranking quincenal.\n\n💰 Premios:\n${PRIZES.map((p, i) => `${MEDALS[i]} ${p} sats`).join('\n')}\n\n¡Sigan participando para escalar posiciones! 🚀`);
    }
    if (state.warned.h1 !== close && remaining <= 3_600_000 && remaining > 50 * 60_000) {
      state.warned.h1 = close;
      persist();
      await broadcast('🚨 **¡ÚLTIMA HORA!** Queda **1 hora** para el cierre del ranking.\n\n🔥 Es la última oportunidad para sumar XP y entrar al podio.');
    }

    if (closesPassed(now) > state.closesDone) {
      state.closesDone = closesPassed(now);
      persist();
      for (const relay of RELAYS) {
        const c = community(relay);
        const top = ranking(c).slice(0, 3);
        const g = c.levelsGroup;
        console.log(`[${PREFIX}] closing cycle on ${relay}: ${top.length} winners`);
        if (g) {
          await post(relay, g, top.length
            ? `🏆 **¡CIERRE DEL RANKING QUINCENAL!** 🏆\n\nEstos son los ganadores:\n\n${top.map(([who, m], i) =>
              `${MEDALS[i]} ${mention(who)} — Nivel ${levelFromTotal(m.xp).level} → **${PRIZES[i]} sats**`).join('\n')}`
              + '\n\n🎉 ¡Felicitaciones a todos! El ranking se reinicia ahora.\nNueva ronda → ¡a participar!'
            : '📊 El ranking quincenal cerró pero no hubo participantes esta vez.');
        }
        resetCommunity(c);
      }
    }
  }

  // ── Subscriptions (one filter per group) ────────────────────────
  const KINDS = [...new Set([9, ...ZAP_KINDS])];
  const subs = new Map();

  function subscribeGroup({ relay, groupId, name }) {
    if (!RELAYS.map(communityKey).includes(communityKey(relay))) return;
    const key = `${relay}|${groupId}`;
    if (name) groupNames.set(key, name);
    if (subs.has(key)) return;
    let closed = false;
    let sub;
    let timer;
    let openedAt = 0;
    let delay = 2_000;
    const cursor = state.cursors[key];
    let since = cursor
      ? Math.max(cursor - 5, Math.floor(Date.now() / 1000) - 6 * 3600)
      : Math.floor(Date.now() / 1000) - 10;

    const open = () => {
      if (closed) return;
      openedAt = Date.now();
      sub = pool.subscribe([relay], { kinds: KINDS, '#h': [groupId], since }, {
        onauth: async () => null,
        onclose: () => {
          if (closed) return;
          // relay29 closes REQs after EOSE; back off only if it keeps failing fast.
          delay = Date.now() - openedAt > 60_000 ? 2_000 : Math.min(delay * 2, 120_000);
          timer = setTimeout(open, delay + Math.floor(Math.random() * 1_000));
        },
        onevent: async (ev) => {
          if (seen.has(ev.id) || ev.pubkey === pk) return;
          rememberSeen(ev.id);
          since = Math.max(since, ev.created_at);
          state.cursors[key] = Math.max(state.cursors[key] || 0, ev.created_at);
          try {
            if (ev.kind === 9) await onMessage(relay, groupId, ev);
            else if (ev.kind === 9735 || isZapReaction(ev)) await onZap(relay, groupId, ev);
            else if (ev.kind === 7) await onReaction(relay, groupId, ev);
          } catch (err) {
            console.warn(`[${PREFIX}] handler error ${relay} ${groupId.slice(0, 8)}:`, err?.message || err);
          }
          persist();
        },
      });
    };
    subs.set(key, { close: () => { closed = true; clearTimeout(timer); try { sub?.close(); } catch {} } });
    timer = setTimeout(open, Math.floor(Math.random() * 3_000));
    console.log(`[${PREFIX}] +group ${relay} ${groupId.slice(0, 8)}${name ? ` (${name.slice(0, 32)})` : ''}`);
  }

  function unsubscribeGroup({ relay, groupId }) {
    const key = `${relay}|${groupId}`;
    subs.get(key)?.close();
    subs.delete(key);
  }

  for (const g of [...STATIC_GROUPS, ...LEVELS_GROUPS]) subscribeGroup(g);
  const watcher = LISTEN_RELAYS.length ? createGroupWatcher(pool, LISTEN_RELAYS, {
    refreshMs: REFRESH_MS,
    filter: (g) => g.isOpen,
    onAdd: subscribeGroup,
    onRemove: unsubscribeGroup,
  }) : null;

  const tickTimer = setInterval(() => tick().catch((err) => console.warn(`[${PREFIX}] tick:`, err?.message || err)), TICK_MS);
  tick().catch(() => {});
  const heartbeat = setInterval(() => {
    const summary = RELAYS.map((r) => `${r.replace('wss://', '')}: ${ranking(community(r)).length} ranked`).join(', ');
    console.log(`[${PREFIX}] alive — ${subs.size} groups; ${summary}`);
  }, 300_000);

  const stop = async () => {
    await commandList.stop();
    clearInterval(tickTimer);
    clearInterval(heartbeat);
    watcher?.stop();
    for (const s of subs.values()) s.close();
    clearTimeout(saveTimer);
    state.seen = [...seen].slice(-3_000);
    saveState(state);
    setTimeout(() => process.exit(0), 300);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv.includes('--self-test')) {
  const check = (cond, msg) => { if (!cond) throw new Error(`self-test failed: ${msg}`); };
  check(levelFromTotal(0).level === 0 && levelFromTotal(99).level === 0, 'level 0');
  check(levelFromTotal(100).level === 1 && levelFromTotal(1100).level === 2, 'levels 1-2');
  check(levelFromTotal(4100).level === 3 && levelFromTotal(4100).toNext === 4000, 'level 3');
  check(LEVELS.length === 22 && LEVELS[20] === 21000, 'table');
  check(levelFromTotal(1e9).level === 22 && levelFromTotal(1e9).toNext === null, 'max level');
  for (let i = 0; i < 1000; i++) {
    const xp = messageXp(50, Math.random() * 200_000 - 50_000);
    check(xp >= 0 && xp < 200, `message xp ${xp}`);
  }
  check(messageXp(0, 0) === 0, 'cooldown');
  console.log('self-test passed');
} else {
  main().catch((err) => {
    console.error(`[${PREFIX}] fatal:`, err?.message || err);
    process.exit(1);
  });
}
