// Widget library for settings: every env var renders as a real control —
// toggles, selects, duration pickers, chip lists, and a visual group picker
// that turns "wss://relay|groupId" strings into named checkboxes.
import { useEffect, useState } from 'preact/hooks'
import { api } from '../api'
import { FieldMeta } from '../settings-meta'
import { shortNpub } from './ui'

interface FieldProps {
  envKey: string
  meta: FieldMeta
  value: string
  set: boolean // secrets: whether a value exists server-side
  secret: boolean
  relaysHint: string // current relays value, feeds the group picker
  botName?: string // group picker auths as this bot (member-gated relays)
  onChange: (v: string) => void
}

export function SettingField(props: FieldProps) {
  const { envKey, meta, secret } = props
  return (
    <div class="py-3 border-b border-lc-border/60 last:border-0">
      <div class="flex items-baseline justify-between gap-3 mb-0.5">
        <span class="text-sm font-medium">{meta.label}</span>
        <code class="text-[10px] text-lc-muted/50" title="env var">{envKey}</code>
      </div>
      {meta.help && <p class="text-xs text-lc-muted mb-2">{meta.help}</p>}
      {secret ? <SecretInput {...props} /> : <Control {...props} />}
    </div>
  )
}

function Control(props: FieldProps) {
  switch (props.meta.widget) {
    case 'toggle': return <Toggle {...props} />
    case 'select': return <Select {...props} />
    case 'duration': return <Duration {...props} />
    case 'number': return (
      <input class="lc-input !w-36" type="number" value={props.value}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
    )
    case 'textarea': return (
      <textarea class="lc-input text-sm h-20 resize-y" value={props.value}
        onInput={(e) => props.onChange((e.target as HTMLTextAreaElement).value)} />
    )
    case 'relays': return <ChipList {...props} placeholder="wss://relay.example.com" mono />
    case 'pubkeys': return <ChipList {...props} placeholder="npub1…" mono shorten />
    case 'groups': return <GroupPicker {...props} />
    default: return (
      <input class="lc-input" value={props.value}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
    )
  }
}

function SecretInput({ value, set, onChange }: FieldProps) {
  return (
    <div class="flex items-center gap-2">
      <input class="lc-input font-mono text-xs" type="password"
        placeholder={set ? '•••••••••••• saved' : 'not set'}
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      {set && <span class="text-[10px] text-lc-green whitespace-nowrap">✓ set</span>}
    </div>
  )
}

function Toggle({ value, onChange }: FieldProps) {
  const on = value === '1' || value.toLowerCase() === 'true'
  return (
    <button type="button" role="switch" aria-checked={on}
      class={`lc-switch ${on ? 'on' : ''}`}
      onClick={() => onChange(on ? '' : '1')}>
      <span class="lc-switch-knob" />
    </button>
  )
}

function Select({ value, meta, onChange }: FieldProps) {
  return (
    <div class="lc-seg !inline-flex">
      {(meta.options ?? []).map((opt) => (
        <button type="button" key={opt}
          class={value === opt || (!value && opt === meta.options?.[0]) ? 'active' : ''}
          onClick={() => onChange(opt)}>
          {opt}
        </button>
      ))}
    </div>
  )
}

// Milliseconds under the hood, humans see seconds/minutes/hours.
function Duration({ value, onChange }: FieldProps) {
  const ms = Number(value) || 0
  const unit = ms >= 3_600_000 && ms % 3_600_000 === 0 ? 3_600_000
    : ms >= 60_000 && ms % 60_000 === 0 ? 60_000 : 1000
  const [u, setU] = useState(unit)
  const amount = ms ? +(ms / u).toFixed(2) : ''
  return (
    <div class="flex gap-2 items-center">
      <input class="lc-input !w-28" type="number" min="0" value={amount}
        placeholder="default"
        onInput={(e) => {
          const n = Number((e.target as HTMLInputElement).value)
          onChange(n ? String(Math.round(n * u)) : '')
        }} />
      <div class="lc-seg !inline-flex">
        {([[1000, 'sec'], [60_000, 'min'], [3_600_000, 'hr']] as const).map(([mult, label]) => (
          <button type="button" key={label} class={u === mult ? 'active' : ''}
            onClick={() => {
              setU(mult)
              if (ms) onChange(String(ms)) // keep stored value, just re-render display
            }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChipList({ value, onChange, placeholder, mono, shorten }: FieldProps & {
  placeholder: string
  mono?: boolean
  shorten?: boolean
}) {
  const [draft, setDraft] = useState('')
  const items = value.split(',').map((s) => s.trim()).filter(Boolean)
  const add = () => {
    if (!draft.trim()) return
    onChange([...items, draft.trim()].join(','))
    setDraft('')
  }
  return (
    <div class="flex flex-wrap gap-1.5 items-center">
      {items.map((item, i) => (
        <span key={i} class={`inline-flex items-center gap-1.5 bg-lc-card border border-lc-border rounded-full px-2.5 py-1 text-xs ${mono ? 'font-mono' : ''}`}
          title={item}>
          {shorten && item.startsWith('npub1') ? shortNpub(item) : item.replace(/^wss:\/\//, '')}
          <button type="button" class="text-lc-muted hover:text-red-400" title="remove"
            onClick={() => onChange(items.filter((_, j) => j !== i).join(','))}>✕</button>
        </span>
      ))}
      <input class={`lc-input !w-56 !py-1 text-xs ${mono ? 'font-mono' : ''}`} placeholder={placeholder}
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        onBlur={add} />
    </div>
  )
}

// The anti-"program a JSON file" widget: shows every channel the dex sees
// (all channel relays, queried server-side in parallel, authed as the bot)
// by NAME with a checkbox; the wss://relay|id strings stay under the hood.
function GroupPicker({ value, botName, onChange }: FieldProps) {
  const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
  const [available, setAvailable] = useState<Map<string, { id: string; name: string; access: string }[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [manual, setManual] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.channels(botName)
      .then((entries) => {
        if (!alive) return
        setAvailable(new Map(entries.map((e) => [e.relay, e.groups])))
        setLoading(false)
      })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [botName])

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next].join(','))
  }

  const known = new Set([...available.entries()].flatMap(([relay, groups]) => groups.map((g) => `${relay}|${g.id}`)))
  const orphans = [...selected].filter((s) => !known.has(s))

  return (
    <div class="space-y-3">
      {loading && <div class="text-xs text-lc-muted flex items-center gap-2"><span class="lc-spinner !w-3.5 !h-3.5" /> loading groups from the relays…</div>}
      {[...available.entries()].map(([relay, groups]) => (
        <div key={relay}>
          <div class="text-[11px] font-mono text-lc-muted mb-1.5">{relay.replace(/^wss:\/\//, '')}</div>
          <div class="flex flex-wrap gap-1.5">
            {groups.slice(0, 30).map((g) => {
              const key = `${relay}|${g.id}`
              const on = selected.has(key)
              // Two groups can share a display name — disambiguate with a
              // short id suffix so the chips aren't identical twins.
              const dupes = groups.filter((o) => o.name === g.name).length > 1
              return (
                <button type="button" key={key}
                  class={`text-xs rounded-full px-3 py-1.5 border transition-colors ${
                    on ? 'bg-lc-olive-dark border-lc-olive text-lc-green font-semibold'
                      : 'bg-lc-card border-lc-border text-lc-muted hover:text-lc-white hover:border-[#3a3a3a]'
                  }`}
                  title={`${g.access} · ${g.id}`}
                  onClick={() => toggle(key)}>
                  {on ? '✓ ' : ''}{g.name || g.id.slice(0, 10)}
                  {dupes && <span class="opacity-50"> ·{g.id.slice(0, 4)}</span>}
                </button>
              )
            })}
            {groups.length > 30 && (
              <span class="text-xs text-lc-muted self-center">+{groups.length - 30} more (add by id below)</span>
            )}
            {groups.length === 0 && (
              <span class="text-xs text-lc-muted/70 self-center">
                no channels visible — this relay only shows its groups to members, so admit the bot there first (or add by id below)
              </span>
            )}
          </div>
        </div>
      ))}
      {!loading && available.size === 0 && (
        <p class="text-xs text-lc-muted">Could not reach the channel relays — add a group manually below.</p>
      )}
      {orphans.map((o) => (
        <span key={o} class="inline-flex items-center gap-1.5 bg-lc-card border border-lc-border rounded-full px-2.5 py-1 text-xs font-mono mr-1.5" title="not found on the relays right now">
          {o.replace(/^wss:\/\//, '')}
          <button type="button" class="text-lc-muted hover:text-red-400" onClick={() => toggle(o)}>✕</button>
        </span>
      ))}
      <details class="text-xs text-lc-muted">
        <summary class="cursor-pointer select-none hover:text-lc-white">add by id instead</summary>
        <div class="flex gap-2 mt-2">
          <input class="lc-input font-mono text-xs" placeholder="wss://public.obelisk.ar|groupId"
            value={manual} onInput={(e) => setManual((e.target as HTMLInputElement).value)} />
          <button type="button" class="lc-pill-secondary text-xs" onClick={() => {
            if (manual.includes('|')) { toggle(manual.trim()); setManual('') }
          }}>add</button>
        </div>
      </details>
    </div>
  )
}
