import { ComponentChildren } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, Bot, EnvEntry } from '../api'
import { metaFor } from '../settings-meta'
import { SettingField } from './fields'
import { Flash, Icon } from './ui'

// Vars that get a card even before they exist in .env.local, so nobody has
// to know their names to set them.
const VIRTUAL_META: Record<string, { label: string; help: string; widget?: 'pubkeys' | 'password' }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key',
    help: 'Lets agents think with Claude. Shared by every agent that has no key of its own.',
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

const AI_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
const NETWORK_KEYS = ['BOT_RELAYS', 'BOT_GROUPS']
const PANEL_KEYS = ['MANAGER_ADMIN_NPUBS']

const SECTIONS = [
  { id: 'network', label: 'Network', hint: 'Default relays & groups' },
  { id: 'ai', label: 'AI credentials', hint: 'Keys for agent bots' },
  { id: 'fleet', label: 'Fleet defaults', hint: 'BOT_* fallbacks' },
  { id: 'panel', label: 'This panel', hint: 'Who can sign in' },
  { id: 'raw', label: 'All variables', hint: 'Raw .env.local, per bot' },
] as const

type Save = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export function Settings(_props: { path?: string }) {
  const [entries, setEntries] = useState<EnvEntry[] | null>(null)
  const [bots, setBots] = useState<Bot[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [save, setSave] = useState<Save>('idle')

  useEffect(() => {
    api.env().then(setEntries).catch((e) => setError(e.message))
    api.bots().then(setBots).catch(() => {})
  }, [])

  const entryFor = (key: string): EnvEntry =>
    entries?.find((e) => e.key === key)
      ?? { key, secret: /KEY|NSEC|TOKEN|SECRET/.test(key), set: false, value: '' }
  const valueOf = (entry: EnvEntry) => edits[entry.key] ?? (entry.secret ? '' : entry.value ?? '')
  const setValue = (key: string, value: string) => {
    setSave('pending')
    setEdits((prev) => ({ ...prev, [key]: value }))
  }

  // Autosave ~1s after the last edit — nothing gets lost by navigating away.
  useEffect(() => {
    if (!Object.keys(edits).length) return
    const timer = setTimeout(async () => {
      const batch = { ...edits }
      setSave('saving')
      try {
        const { entries: fresh } = await api.saveEnv(batch)
        setEntries(fresh)
        setEdits((prev) => {
          const next = { ...prev }
          for (const k of Object.keys(batch)) if (next[k] === batch[k]) delete next[k]
          return next
        })
        setError('')
        setSave('saved')
      } catch (e) {
        setError((e as Error).message)
        setSave('error')
      }
    }, 1000)
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

  const fleetKeys = entries
    .map((e) => e.key)
    .filter((k) => /^BOT_/.test(k) && !NETWORK_KEYS.includes(k) && k !== 'BOT_NSEC')
  const aiReady = AI_KEYS.some((k) => entryFor(k).set)

  return (
    <div class="animate-fade-in-up lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
      <aside class="hidden lg:block">
        <nav class="sticky top-0 space-y-1">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} class="block rounded-lg px-3 py-2 hover:bg-lc-card transition-colors"
              onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }}>
              <div class="text-sm font-semibold">{s.label}</div>
              <div class="text-[11px] text-lc-muted">{s.hint}</div>
            </a>
          ))}
          <div class="pt-4 px-3"><SaveStatus state={save} /></div>
        </nav>
      </aside>

      <div class="min-w-0">
        <div class="lg:hidden flex justify-end mb-3"><SaveStatus state={save} /></div>
        <Flash kind="err" text={error} />

        <Card id="network" title="Network" intro="Where bots connect by default. A bot's own relays/groups (on its page) take precedence.">
          {field('BOT_RELAYS', { label: 'Relays', help: 'The servers bots connect and publish to.' })}
          {field('BOT_GROUPS', { label: 'Groups', help: 'Group chats bots join by default — pick them from the list.' })}
        </Card>

        <Card id="ai" title="AI credentials"
          intro="Shared brains for agent-type bots. Any agent without its own key uses these."
          badge={aiReady ? <span class="lc-chip !text-lc-green">✓ ready</span> : <span class="lc-chip !text-yellow-400">no key yet</span>}>
          {AI_KEYS.map((k) => field(k))}
        </Card>

        <Card id="fleet" title="Fleet defaults"
          intro="BOT_* values every bot falls back to when it doesn't set its own. Restart bots to apply.">
          {fleetKeys.length
            ? fleetKeys.map((k) => field(k))
            : <p class="text-sm text-lc-muted">No fleet-wide defaults set.</p>}
        </Card>

        <Card id="panel" title="This panel" intro="Access to agents.obelisk.ar.">
          {PANEL_KEYS.map((k) => field(k))}
        </Card>

        <RawVariables entries={entries} bots={bots} valueOf={valueOf} setValue={setValue} />
      </div>
    </div>
  )
}

function SaveStatus({ state }: { state: Save }) {
  if (state === 'idle') return <span class="text-xs text-lc-muted">Changes save automatically</span>
  if (state === 'pending' || state === 'saving') {
    return <span class="text-xs text-lc-muted flex items-center gap-1.5"><span class="lc-spinner !w-3 !h-3" /> saving…</span>
  }
  if (state === 'error') return <span class="text-xs text-red-400">✕ not saved</span>
  return <span class="text-xs text-lc-green" title="Restart affected bots to apply">✓ saved · restart bots to apply</span>
}

function Card({ id, title, intro, badge, children }: {
  id: string
  title: string
  intro: string
  badge?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <section id={id} class="lc-card p-5 sm:p-6 mb-6 scroll-mt-4">
      <div class="flex items-start justify-between gap-3">
        <h2 class="font-bold text-lg">{title}</h2>
        {badge}
      </div>
      <p class="text-xs text-lc-muted mt-1 mb-3 max-w-2xl">{intro}</p>
      {children}
    </section>
  )
}

// Every raw variable, grouped by the bot that reads it, with a search box.
function RawVariables({ entries, bots, valueOf, setValue }: {
  entries: EnvEntry[]
  bots: Bot[]
  valueOf: (e: EnvEntry) => string
  setValue: (key: string, value: string) => void
}) {
  const [query, setQuery] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const groups = useMemo(() => {
    const owner = new Map<string, string>()
    for (const b of bots) {
      for (const v of b.envVars) if (!/^(BOT|AGENT)_/.test(v.key)) owner.set(v.key, b.name)
    }
    const out = new Map<string, EnvEntry[]>()
    for (const e of entries) {
      const g = owner.get(e.key)
        ?? (/^(BOT|AGENT)_/.test(e.key) ? 'Fleet-wide' : /^MANAGER_/.test(e.key) ? 'Panel' : 'Other')
      if (!out.has(g)) out.set(g, [])
      out.get(g)!.push(e)
    }
    return [...out.entries()].sort(([a], [b]) => {
      const rank = (n: string) => (n === 'Fleet-wide' ? 0 : n === 'Panel' ? 2 : n === 'Other' ? 3 : 1)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
  }, [entries, bots])

  const q = query.trim().toUpperCase()
  const shown = groups
    .map(([g, list]) => [g, list.filter((e) => !q || e.key.includes(q) || g.toUpperCase().includes(q))] as const)
    .filter(([, list]) => list.length)

  return (
    <section id="raw" class="lc-card p-5 sm:p-6 mb-6 scroll-mt-4">
      <h2 class="font-bold text-lg">All variables</h2>
      <p class="text-xs text-lc-muted mt-1 mb-4 max-w-2xl">
        Everything in <code>.env.local</code>, grouped by the bot that reads it. Prefer each bot's own
        Settings tab — this is the escape hatch. Secrets are never shown; type to replace them.
      </p>

      <label class="lc-search mb-4">
        <Icon.search />
        <input placeholder={`Search ${entries.length} variables…`} value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </label>

      <div class="space-y-2">
        {shown.map(([group, list]) => (
          <details key={group} class="rounded-lg border border-lc-border overflow-hidden" open={!!q}>
            <summary class="flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none hover:bg-lc-card">
              <span class="font-semibold text-sm flex-1 truncate">{group.replace(/^obelisk-/, '')}</span>
              <span class="text-xs text-lc-muted">{list.length}</span>
              {group.startsWith('obelisk-') && (
                <a href={`/bots/${group}#settings`} class="text-xs text-lc-green hover:underline"
                  onClick={(e) => e.stopPropagation()}>bot settings →</a>
              )}
            </summary>
            <div class="px-4 pb-3 pt-1 divide-y divide-lc-border/60">
              {list.map((entry) => (
                <div key={entry.key} class="py-2 sm:flex sm:items-center sm:gap-3">
                  <div class="sm:w-72 min-w-0 flex items-center gap-2 mb-1 sm:mb-0">
                    <span class="font-mono text-xs truncate" title={entry.key}>{entry.key}</span>
                    {entry.secret && (entry.set
                      ? <span class="text-[10px] text-lc-green whitespace-nowrap">✓ set</span>
                      : <span class="text-[10px] text-lc-muted whitespace-nowrap">empty</span>)}
                  </div>
                  <input
                    class="lc-input font-mono text-xs flex-1"
                    type={entry.secret ? 'password' : 'text'}
                    autocomplete="off"
                    placeholder={entry.secret ? (entry.set ? '•••••• saved — type to replace' : 'not set') : ''}
                    value={valueOf(entry)}
                    onInput={(e) => setValue(entry.key, (e.target as HTMLInputElement).value)}
                  />
                </div>
              ))}
            </div>
          </details>
        ))}
        {!shown.length && <p class="text-sm text-lc-muted">No variable matches “{query}”.</p>}
      </div>

      <form
        class="mt-5 pt-4 border-t border-lc-border sm:flex gap-3 space-y-2 sm:space-y-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (!newKey.trim()) return
          setValue(newKey.trim().toUpperCase(), newValue)
          setNewKey('')
          setNewValue('')
        }}
      >
        <input class="lc-input font-mono text-xs sm:!w-72" placeholder="NEW_VARIABLE"
          value={newKey} onInput={(e) => setNewKey((e.target as HTMLInputElement).value)} />
        <input class="lc-input font-mono text-xs flex-1" placeholder="value"
          value={newValue} onInput={(e) => setNewValue((e.target as HTMLInputElement).value)} />
        <button class="lc-pill-secondary text-xs whitespace-nowrap">+ Add variable</button>
      </form>
    </section>
  )
}
