// Advertises a bot's chat commands so clients (the dex's `/` picker) can
// list them. Publishes, to every relay the bot serves, a NIP-78 kind 30078
// parameterized-replaceable event signed by the bot:
//
//   ["d",   "obelisk:bot-commands:<relayUrl>"]   one slot per relay
//   ["t",   "obelisk-bot-commands"]              discovery: REQ {"#t":[…]}
//   ["alt", "Obelisk bot command list"]          NIP-31
//   ["cmd", "!milugar", "<description>", "<example>"]   one per command
//   content: {"v":1,"name":"<bot>","commands":[{command,description,example}]}
//
// The list comes from bots/<name>.commands.json next to the bot script.
// Republished every HEARTBEAT_MS so created_at doubles as "alive" (the dex
// hides lists older than 1 h); stop() publishes an empty list to clear it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent } from 'nostr-tools';

const KIND = 30078;
const TOPIC = 'obelisk-bot-commands';
const HEARTBEAT_MS = 20 * 60_000;

function scriptFile(script) {
  if (!script) return process.argv[1];
  return script.startsWith('file:') ? fileURLToPath(script) : script;
}

export function readCommandManifest(script) {
  const manifest = scriptFile(script).replace(/\.mjs$/, '.commands.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.commands;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && c.command)
      .map((c) => ({
        command: String(c.command),
        description: c.description ? String(c.description) : null,
        example: c.example ? String(c.example) : null,
      }));
  } catch {
    return [];
  }
}

export function commandsEvent(sk, relay, name, commands) {
  return finalizeEvent({
    kind: KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `obelisk:bot-commands:${relay.replace(/\/+$/, '')}`],
      ['t', TOPIC],
      ['alt', 'Obelisk bot command list'],
      ...commands.map((c) => ['cmd', c.command, c.description ?? '', c.example ?? '']),
    ],
    content: JSON.stringify({ v: 1, name, commands }),
  }, sk);
}

export function advertiseCommands({ pool, sk, relays, script, name, logPrefix }) {
  const file = scriptFile(script);
  const botName = name || path.basename(file, '.mjs');
  const prefix = logPrefix || botName;
  const commands = readCommandManifest(file);
  const targets = [...new Set(relays.map((r) => r.replace(/\/+$/, '')))];
  if (!commands.length) {
    console.log(`[${prefix}] no commands in ${path.basename(file, '.mjs')}.commands.json — not advertising`);
    return { stop: async () => {} };
  }
  const warned = new Set();

  // NIP-42: the first publish on a fresh connection is often refused with
  // auth-required while the pool answers the challenge — retry once after.
  async function publishTo(relay, list) {
    try {
      await Promise.any(pool.publish([relay], commandsEvent(sk, relay, botName, list)));
    } catch (err) {
      if (!/auth-required/.test(err?.errors?.[0]?.message || err?.message || '')) throw err;
      await new Promise((r) => setTimeout(r, 1_500));
      await Promise.any(pool.publish([relay], commandsEvent(sk, relay, botName, list)));
    }
  }

  async function publish(list) {
    const ok = await Promise.all(targets.map(async (relay) => {
      try {
        await publishTo(relay, list);
        warned.delete(relay);
        return true;
      } catch (err) {
        if (!warned.has(relay)) {
          warned.add(relay);
          console.warn(`[${prefix}] command list publish failed ${relay}: ${err?.errors?.[0]?.message || err?.message || err}`);
        }
        return false;
      }
    }));
    return ok.filter(Boolean).length;
  }

  publish(commands).then((n) => {
    if (n) console.log(`[${prefix}] advertised ${commands.length} commands on ${n}/${targets.length} relay(s)`);
  });
  const timer = setInterval(() => { publish(commands); }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      await Promise.race([publish([]), new Promise((r) => setTimeout(r, 3_000))]);
    },
  };
}
