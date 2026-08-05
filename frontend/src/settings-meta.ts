// Human metadata for env vars: label, help text, and which widget renders
// them. Matched by suffix pattern so new bots' vars are understood
// automatically as long as they follow the naming conventions.

export type Widget =
  | 'text'
  | 'password'
  | 'number'
  | 'toggle'
  | 'select'
  | 'duration'
  | 'textarea'
  | 'relays'
  | 'groups'
  | 'pubkeys'

export type Section = 'identity' | 'connection' | 'behavior' | 'llm' | 'advanced'

export interface FieldMeta {
  label: string
  help?: string
  widget: Widget
  options?: string[]
  section: Section
}

const RULES: [RegExp, FieldMeta][] = [
  [/_NSEC$/, {
    label: 'Identity key',
    help: 'The bot\'s private key (nsec). Stored server-side, never shown. Type a new one only to rotate it.',
    widget: 'password', section: 'identity',
  }],
  [/_LISTEN_RELAYS$/, {
    label: 'Listen relays',
    help: 'Extra relays it watches for incoming events.',
    widget: 'relays', section: 'connection',
  }],
  [/_RELAYS$/, {
    label: 'Relays',
    help: 'The servers this bot connects and publishes to.',
    widget: 'relays', section: 'connection',
  }],
  [/_GROUPS$/, {
    label: 'Groups',
    help: 'The group chats this bot lives in. Pick them from the list — no ids needed.',
    widget: 'groups', section: 'connection',
  }],
  [/_ALLOWED_PUBKEYS$/, {
    label: 'Who can talk to it',
    help: 'Only these people are heard — everyone else is invisible to the agent.',
    widget: 'pubkeys', section: 'behavior',
  }],
  [/_SYSTEM_PROMPT$/, {
    label: 'Personality',
    help: 'Instructions that shape how the agent behaves and talks.',
    widget: 'textarea', section: 'behavior',
  }],
  [/_TRIGGER$/, {
    label: 'Replies to',
    help: '"mention" = only when tagged or @named. "all" = every whitelisted message.',
    widget: 'select', options: ['mention', 'all'], section: 'behavior',
  }],
  [/_LLM_PROVIDER$/, {
    label: 'AI provider',
    widget: 'select', options: ['anthropic', 'openai'], section: 'llm',
  }],
  [/_LLM_MODEL$/, {
    label: 'AI model',
    help: 'e.g. claude-opus-5 (Anthropic) or gpt-4o-mini (OpenAI).',
    widget: 'text', section: 'llm',
  }],
  [/_LLM_API_KEY/, {
    label: 'AI API key',
    help: 'Provider credit key. Leave empty to use the shared key from Settings.',
    widget: 'password', section: 'llm',
  }],
  [/_LLM_BASE_URL$/, {
    label: 'AI endpoint',
    help: 'Only for OpenAI-compatible services (OpenRouter, local server, …).',
    widget: 'text', section: 'llm',
  }],
  [/_LLM_MAX_TOKENS$/, {
    label: 'Max reply length',
    help: 'In tokens — roughly ¾ of a word each.',
    widget: 'number', section: 'llm',
  }],
  [/_MIN_SATS$/, {
    label: 'Minimum zap',
    help: 'Zaps below this many sats are ignored.',
    widget: 'number', section: 'behavior',
  }],
  [/_CHAT_EVERY_N_TICKS$/, {
    label: 'Post to chat every…',
    help: 'Sends a chat message every N price updates (the profile name updates every tick).',
    widget: 'number', section: 'behavior',
  }],
  [/(_INTERVAL_MS|_THROTTLE_MS|_HEARTBEAT_MS|_REFRESH_MS|_RECONNECT_MS|_REPLY_GAP_MS)$/, {
    label: '', // filled per-key below
    widget: 'duration', section: 'behavior',
  }],
  [/_DEBUG$/, {
    label: 'Debug logging',
    help: 'Extra detail in the logs while troubleshooting.',
    widget: 'toggle', section: 'advanced',
  }],
  [/_HELLO$/, {
    label: 'Hello message',
    help: 'Posted once when the bot joins a group. Leave empty for silence.',
    widget: 'textarea', section: 'behavior',
  }],
  [/_TEMPLATE$/, {
    label: 'Message template',
    widget: 'textarea', section: 'behavior',
  }],
  [/_DISPLAY(_|$)/, {
    label: 'Display name',
    help: 'Shown as the bot\'s name in clients.',
    widget: 'text', section: 'behavior',
  }],
  [/_CONTEXT_SIZE$/, {
    label: 'Conversation memory',
    help: 'How many recent messages the agent remembers per group.',
    widget: 'number', section: 'llm',
  }],
  [/_SEEN_MAX$|_STATE_PATH$|_GROUP_ID$/, {
    label: '',
    widget: 'text', section: 'advanced',
  }],
]

const DURATION_LABELS: [RegExp, string, string][] = [
  [/_INTERVAL_MS$/, 'Update every', 'How often it fetches fresh data and updates.'],
  [/_THROTTLE_MS$/, 'Quiet period', 'Minimum time between repeated messages.'],
  [/_HEARTBEAT_MS$/, 'Heartbeat', 'How often it logs a sign of life.'],
  [/_REFRESH_MS$/, 'Refresh every', 'How often it re-scans for new groups.'],
  [/_RECONNECT_MS$/, 'Reconnect after', 'Wait before retrying a dropped relay.'],
  [/_REPLY_GAP_MS$/, 'Reply cooldown', 'Minimum pause between replies in one group.'],
]

const prettify = (key: string) =>
  key.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export function metaFor(key: string): FieldMeta {
  for (const [pattern, meta] of RULES) {
    if (!pattern.test(key)) continue
    if (meta.widget === 'duration') {
      for (const [p, label, help] of DURATION_LABELS) {
        if (p.test(key)) return { ...meta, label, help }
      }
      return { ...meta, label: prettify(key.replace(/_MS$/, '')) }
    }
    return { ...meta, label: meta.label || prettify(key) }
  }
  return { label: prettify(key), widget: 'text', section: 'advanced' }
}

export const SECTION_TITLES: Record<Section, string> = {
  identity: 'Identity',
  connection: 'Where it lives',
  behavior: 'Behavior',
  llm: 'AI brain',
  advanced: 'Advanced',
}
