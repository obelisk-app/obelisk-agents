import { useEffect, useState } from 'preact/hooks'
import { api, EnvEntry } from '../api'
import { metaFor } from '../settings-meta'
import { SettingField } from './fields'
import { Flash, Section } from './ui'
import { toast } from './toast'

// Vars that get a card even before they exist in .env.local, so nobody has
// to know their names to set them.
const VIRTUAL: { key: string; card: 'ai' | 'manager' }[] = [
  { key: 'ANTHROPIC_API_KEY', card: 'ai' },
  { key: 'OPENAI_API_KEY', card: 'ai' },
  { key: 'MANAGER_ADMIN_NPUBS', card: 'manager' },
]

const VIRTUAL_META: Record<string, { label: string; help: string; widget?: 'pubkeys' | 'password' }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key',
    help: 'Lets agents think with Claude (default model claude-opus-5). Shared by every agent that has no key of its own.',
    widget: 'password',
  },
  OPENAI_API_KEY: {
    label: 'OpenAI API key',
    help: 'Alternative brain for agents via OpenAI or any compatible service.',
    widget: 'password',
  },
  MANAGER_ADMIN_NPUBS: {
    label: 'Panel admins',
    help: 'Who can sign in here. Empty = just the owner npub.',
    widget: 'pubkeys',
  },
}

export function Settings(_props: { path?: string }) {
  const [entries, setEntries] = useState<EnvEntry[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  useEffect(() => {
    api.env().then(setEntries).catch((e) => setError(e.message))
  }, [])

  const entryFor = (key: string): EnvEntry =>
    entries?.find((e) => e.key === key)
      ?? { key, secret: /KEY|NSEC|TOKEN|SECRET/.test(key), set: false, value: '' }
  const valueOf = (entry: EnvEntry) => edits[entry.key] ?? (entry.secret ? '' : entry.value ?? '')
  const setValue = (key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value }))

  // Autosave ~1s after the last edit — nothing gets lost by navigating away.
  useEffect(() => {
    if (!Object.keys(edits).length) return
    const timer = setTimeout(async () => {
      const batch = { ...edits }
      setBusy(true)
      try {
        const { entries: fresh } = await api.saveEnv(batch)
        setEntries(fresh)
        setEdits((prev) => {
          const next = { ...prev }
          for (const k of Object.keys(batch)) if (next[k] === batch[k]) delete next[k]
          return next
        })
        toast.ok('Saved — restart affected bots from the fleet page to apply.')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    }, 1200)
    return () => clearTimeout(timer)
  }, [edits])

  if (!entries) return error ? <Flash kind="err" text={error} /> : <div class="lc-card h-64 lc-skeleton" />

  const relaysHint = valueOf(entryFor('BOT_RELAYS')) || 'wss://public.obelisk.ar'

  const field = (key: string, overrides?: { label?: string; help?: string }) => {
    const entry = entryFor(key)
    const virtual = VIRTUAL_META[key]
    const meta = {
      ...metaFor(key),
      ...(virtual ? { label: virtual.label, help: virtual.help, ...(virtual.widget ? { widget: virtual.widget } : {}) } : {}),
      ...overrides,
    }
    // pubkeys widget needs the raw value even though the var name looks secret
    const secret = meta.widget === 'password' ? true : entry.secret && meta.widget !== 'pubkeys'
    return (
      <SettingField
        key={key}
        envKey={key}
        meta={meta}
        value={valueOf(entry)}
        set={!!entry.set}
        secret={secret}
        relaysHint={relaysHint}
        onChange={(v) => setValue(key, v)}
      />
    )
  }

  // Everything without a friendly card lands in Advanced.
  const surfaced = new Set(['BOT_RELAYS', 'BOT_GROUPS', ...VIRTUAL.map((v) => v.key)])
  const advanced = entries.filter((e) => !surfaced.has(e.key))

  return (
    <div class="animate-fade-in-up">
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-2xl font-extrabold">Settings</h1>
        {(busy || Object.keys(edits).length > 0) && (
          <span class="text-xs text-lc-muted flex items-center gap-1.5">
            <span class="lc-spinner !w-3 !h-3" /> saving…
          </span>
        )}
      </div>
      <p class="text-sm text-lc-muted mb-6">
        Fleet-wide defaults — changes <span class="text-lc-green">save automatically</span>.
        Each bot's own page can override any of this for itself.
      </p>

      <Flash kind="err" text={error} />

      <Section title="Network defaults">
        <p class="text-xs text-lc-muted mb-2">
          Used by every bot that doesn't set its own relays or groups.
        </p>
        {field('BOT_RELAYS', { label: 'Relays', help: 'The servers bots connect and publish to.' })}
        {field('BOT_GROUPS', { label: 'Groups', help: 'Group chats bots join by default — pick them from the list.' })}
      </Section>

      <Section title="AI credentials">
        <p class="text-xs text-lc-muted mb-2">
          Shared brains for agent-type bots. A key set here works for every agent;
          individual agents can override it on their own page.
        </p>
        {VIRTUAL.filter((v) => v.card === 'ai').map((v) => field(v.key))}
      </Section>

      <Section title="This panel">
        {VIRTUAL.filter((v) => v.card === 'manager').map((v) => field(v.key))}
      </Section>

      <Section title="Advanced">
        <details>
          <summary class="text-xs text-lc-muted cursor-pointer select-none hover:text-lc-white">
            Every raw variable in .env.local ({advanced.length}) — you rarely need this
          </summary>
          <div class="space-y-2 mt-4">
            {advanced.map((entry) => (
              <div key={entry.key} class="flex gap-3 items-center">
                <span class="font-mono text-xs text-lc-muted w-64 truncate" title={entry.key}>{entry.key}</span>
                <input
                  class="lc-input font-mono text-xs flex-1"
                  type={entry.secret ? 'password' : 'text'}
                  placeholder={entry.secret ? (entry.set ? '•••••• saved' : 'not set') : ''}
                  value={valueOf(entry)}
                  onInput={(e) => setValue(entry.key, (e.target as HTMLInputElement).value)}
                />
              </div>
            ))}
            <form
              class="flex gap-3 pt-3 border-t border-lc-border"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newKey.trim()) return
                setValue(newKey.trim().toUpperCase(), newValue)
                setNewKey('')
                setNewValue('')
              }}
            >
              <input class="lc-input font-mono text-xs w-64" placeholder="NEW_VARIABLE"
                value={newKey} onInput={(e) => setNewKey((e.target as HTMLInputElement).value)} />
              <input class="lc-input font-mono text-xs flex-1" placeholder="value"
                value={newValue} onInput={(e) => setNewValue((e.target as HTMLInputElement).value)} />
              <button class="lc-pill-secondary text-xs whitespace-nowrap">+ Add</button>
            </form>
          </div>
        </details>
      </Section>
    </div>
  )
}
