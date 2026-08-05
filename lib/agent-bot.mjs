// Shared runtime for **agent** bots: LLM-connected group members that only
// listen to whitelisted users. A concrete agent under bots/ is just:
//
//   import { runAgent } from '../lib/agent-bot.mjs';
//   runAgent({ name: 'helper', envPrefix: 'HELPER' });
//
// Env contract (all prefixed, BOT_*/AGENT_* fallbacks in parentheses):
//   <P>_NSEC              identity                     (BOT_NSEC)
//   <P>_RELAYS            comma relays                 (BOT_RELAYS)
//   <P>_GROUPS            comma wss://relay|groupId    (BOT_GROUPS)
//   <P>_ALLOWED_PUBKEYS   comma npub/hex — ONLY these users are heard
//                         (AGENT_ALLOWED_PUBKEYS; empty ⇒ deaf, logs a warning)
//   <P>_SYSTEM_PROMPT     persona / instructions for the LLM
//   <P>_TRIGGER           mention | all   (default mention: reply only when
//                         the message mentions the agent or starts with @name)
//   <P>_LLM_*             see lib/llm.mjs
import { finalizeEvent, nip19 } from 'nostr-tools';
import { identityFromEnv, parsePubkey } from './secret.mjs';
import { createPool, parseGroupList } from './pool.mjs';
import { llmFromEnv } from './llm.mjs';

const now = () => Math.floor(Date.now() / 1000);

function envOr(prefix, key, fallback) {
  return process.env[`${prefix}_${key}`] ?? fallback;
}

export function runAgent({ name, envPrefix }) {
  const prefix = envPrefix ?? name.toUpperCase().replace(/-/g, '_');
  const log = (...args) => console.log(`[${name}]`, ...args);

  const { sk, pk, npub } = identityFromEnv(
    process.env[`${prefix}_NSEC`] ? `${prefix}_NSEC` : 'BOT_NSEC',
  );
  const RELAYS = (envOr(prefix, 'RELAYS', process.env.BOT_RELAYS) ?? 'wss://public.obelisk.ar')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const GROUPS = parseGroupList(envOr(prefix, 'GROUPS', process.env.BOT_GROUPS ?? ''));
  const TRIGGER = envOr(prefix, 'TRIGGER', 'mention');
  const CONTEXT_SIZE = Number(envOr(prefix, 'CONTEXT_SIZE', 30));
  const MIN_REPLY_GAP_MS = Number(envOr(prefix, 'MIN_REPLY_GAP_MS', 4000));

  const allowed = new Set(
    (envOr(prefix, 'ALLOWED_PUBKEYS', process.env.AGENT_ALLOWED_PUBKEYS) ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(parsePubkey),
  );

  const llm = llmFromEnv(prefix);
  const system = envOr(prefix, 'SYSTEM_PROMPT',
    `You are ${name}, a helpful member of a group chat on the Obelisk Nostr network. `
    + 'Reply briefly and conversationally (a few sentences, plain text, no markdown headings). '
    + 'You only see messages from authorized users.');

  if (GROUPS.length === 0) log(`WARNING: ${prefix}_GROUPS is empty — nothing to listen to`);
  if (allowed.size === 0) log(`WARNING: ${prefix}_ALLOWED_PUBKEYS is empty — the agent hears nobody`);
  log(`running as ${npub}`);
  log(`llm: ${llm.provider} ${llm.model} · trigger: ${TRIGGER} · whitelist: ${allowed.size} pubkey(s)`);

  const pool = createPool(sk);
  const seen = new Set();
  const contexts = new Map(); // groupId -> [{ role, content }]
  const lastReplyAt = new Map(); // groupId -> ms
  const startedAt = now();

  const mentioned = (content) => {
    const c = content.toLowerCase();
    return c.includes(npub) || c.includes(pk) || c.startsWith(`@${name.toLowerCase()}`);
  };

  function remember(groupId, role, content) {
    const buf = contexts.get(groupId) ?? [];
    // Merge consecutive same-role turns — the Messages API requires
    // alternation, and several user messages in a row are common in chat.
    const last = buf[buf.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else buf.push({ role, content });
    while (buf.length > CONTEXT_SIZE) buf.shift();
    contexts.set(groupId, buf);
  }

  async function reply(group, ev) {
    const at = Date.now();
    if (at - (lastReplyAt.get(group.groupId) ?? 0) < MIN_REPLY_GAP_MS) return;
    lastReplyAt.set(group.groupId, at);

    const messages = structuredClone(contexts.get(group.groupId) ?? []);
    if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: '(conversation begins)' });
    let text;
    try {
      text = await llm.complete({ system, messages });
    } catch (err) {
      log(`llm error: ${err.message}`);
      return;
    }
    if (!text) return;
    text = text.slice(0, 2000);

    const out = finalizeEvent({
      kind: 9,
      created_at: now(),
      tags: [['h', group.groupId], ['e', ev.id]],
      content: text,
    }, sk);
    try {
      await Promise.any(pool.publish([group.relay], out));
      remember(group.groupId, 'assistant', text);
      log(`replied in ${group.groupId} (${text.length} chars)`);
    } catch {
      log(`publish rejected by ${group.relay}`);
    }
  }

  function subscribe(group) {
    const sub = pool.subscribe([group.relay], {
      kinds: [9],
      '#h': [group.groupId],
      since: startedAt,
    }, {
      onevent(ev) {
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
        if (ev.pubkey === pk) return;
        // The whitelist is the security boundary: unauthorized users are
        // fully ignored — they don't trigger replies AND never enter the
        // LLM context (prompt-injection surface stays closed).
        if (!allowed.has(ev.pubkey)) return;
        const label = nip19.npubEncode(ev.pubkey).slice(0, 12);
        remember(group.groupId, 'user', `${label}: ${ev.content}`);
        if (TRIGGER === 'all' || mentioned(ev.content)) reply(group, ev);
      },
      onclose() {
        log(`sub closed for ${group.groupId}@${group.relay} — resubscribing in 5s`);
        setTimeout(() => subscribe(group), 5000);
      },
    });
    return sub;
  }

  for (const group of GROUPS) subscribe(group);
}
