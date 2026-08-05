import { useEffect, useState } from 'preact/hooks'
import { api, EnvEntry } from '../api'
import { CopyChip, Flash, Section } from './ui'

const isListKey = (key: string) => /_RELAYS$|_GROUPS$/.test(key)

export function Settings(_props: { path?: string }) {
  const [entries, setEntries] = useState<EnvEntry[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  useEffect(() => {
    api.env().then(setEntries).catch((e) => setError(e.message))
  }, [])

  const valueOf = (entry: EnvEntry) => edits[entry.key] ?? (entry.secret ? '' : entry.value ?? '')
  const setValue = (key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value }))
  const dirty = Object.keys(edits).length > 0

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const { entries: fresh } = await api.saveEnv(edits)
      setEntries(fresh)
      setEdits({})
      setFlash('Saved to .env.local (backup kept). Restart affected bots from the dashboard to apply.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addVar = async (e: Event) => {
    e.preventDefault()
    if (!newKey.trim()) return
    setValue(newKey.trim().toUpperCase(), newValue)
    setNewKey('')
    setNewValue('')
  }

  if (!entries) return error ? <Flash kind="err" text={error} /> : <div class="lc-card h-64 lc-skeleton" />

  const listEntries = entries.filter((e) => !e.secret && isListKey(e.key))
  const rest = entries.filter((e) => !listEntries.includes(e))

  return (
    <div class="animate-fade-in-up">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-extrabold">Settings <span class="text-lc-muted font-normal text-base">· .env.local</span></h1>
        {dirty && (
          <button class="lc-pill-primary" disabled={busy} onClick={save}>
            {busy ? <span class="lc-spinner" /> : `Save ${Object.keys(edits).length} change${Object.keys(edits).length > 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      <Flash kind="err" text={error} />
      <Flash kind="ok" text={flash} />

      <Section title="Relay & group lists">
        <p class="text-xs text-lc-muted mb-4">
          The server lists every bot connects to. Relays are plain URLs; groups are{' '}
          <span class="font-mono">wss://relay|groupId</span>. Use the group browser below to find ids.
        </p>
        <div class="space-y-5">
          {listEntries.map((entry) => (
            <ListEditor
              key={entry.key}
              label={entry.key}
              value={valueOf(entry)}
              onChange={(v) => setValue(entry.key, v)}
            />
          ))}
        </div>
      </Section>

      <GroupBrowser />

      <Section title="All variables">
        <div class="space-y-2">
          {rest.map((entry) => (
            <div key={entry.key} class="flex gap-3 items-center">
              <span class="font-mono text-xs text-lc-muted w-64 truncate" title={entry.key}>{entry.key}</span>
              <input
                class="lc-input font-mono text-xs flex-1"
                type={entry.secret ? 'password' : 'text'}
                placeholder={entry.secret ? (entry.set ? '•••••• (set — type to replace)' : 'not set') : ''}
                value={valueOf(entry)}
                onInput={(e) => setValue(entry.key, (e.target as HTMLInputElement).value)}
              />
            </div>
          ))}
        </div>
        <form class="flex gap-3 mt-4 pt-4 border-t border-lc-border" onSubmit={addVar}>
          <input class="lc-input font-mono text-xs w-64" placeholder="NEW_VARIABLE"
            value={newKey} onInput={(e) => setNewKey((e.target as HTMLInputElement).value)} />
          <input class="lc-input font-mono text-xs flex-1" placeholder="value"
            value={newValue} onInput={(e) => setNewValue((e.target as HTMLInputElement).value)} />
          <button class="lc-pill-secondary text-xs whitespace-nowrap">+ Add</button>
        </form>
      </Section>
    </div>
  )
}

function ListEditor({ label, value, onChange }: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const [draft, setDraft] = useState('')
  const items = value.split(',').map((s) => s.trim()).filter(Boolean)

  const add = (e: Event) => {
    e.preventDefault()
    if (!draft.trim()) return
    onChange([...items, draft.trim()].join(','))
    setDraft('')
  }

  return (
    <div>
      <div class="font-mono text-xs text-lc-muted mb-2">{label}</div>
      <div class="flex flex-wrap gap-2 items-center">
        {items.map((item, i) => (
          <span key={i} class="inline-flex items-center gap-1.5 bg-lc-card border border-lc-border rounded-full px-3 py-1 text-xs font-mono">
            {item}
            <button
              class="text-lc-muted hover:text-red-400 transition-colors"
              title="remove"
              onClick={() => onChange(items.filter((_, j) => j !== i).join(','))}
            >
              ✕
            </button>
          </span>
        ))}
        <form class="inline-flex gap-1" onSubmit={add}>
          <input
            class="lc-input !w-72 !py-1 text-xs font-mono"
            placeholder={label.endsWith('_GROUPS') ? 'wss://relay.obelisk.ar|groupId' : 'wss://relay.example.com'}
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          />
          <button class="lc-pill-secondary text-xs !px-3 !py-1">add</button>
        </form>
      </div>
    </div>
  )
}

function GroupBrowser() {
  const [relay, setRelay] = useState('wss://relay.obelisk.ar')
  const [groups, setGroups] = useState<{ id: string; access: string; name: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setGroups(await api.groups(relay))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Group browser">
      <form class="flex gap-2 mb-4" onSubmit={load}>
        <input class="lc-input font-mono text-xs flex-1" value={relay}
          onInput={(e) => setRelay((e.target as HTMLInputElement).value)} />
        <button class="lc-pill-secondary text-xs whitespace-nowrap" disabled={busy}>
          {busy ? <span class="lc-spinner" /> : 'List groups'}
        </button>
      </form>
      <Flash kind="err" text={error} />
      {groups && (
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-lc-muted text-left">
                <th class="py-2 pr-4">group</th>
                <th class="py-2 pr-4">access</th>
                <th class="py-2 pr-4">id</th>
                <th class="py-2">for BOT_GROUPS</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} class="border-t border-lc-border">
                  <td class="py-2 pr-4 font-medium">{g.name || '(unnamed)'}</td>
                  <td class="py-2 pr-4 text-lc-muted">{g.access}</td>
                  <td class="py-2 pr-4 font-mono">{g.id}</td>
                  <td class="py-2"><CopyChip text={`${relay}|${g.id}`} label="copy relay|id" /></td>
                </tr>
              ))}
              {groups.length === 0 && (
                <tr><td colSpan={4} class="py-3 text-lc-muted">No groups visible on this relay.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
