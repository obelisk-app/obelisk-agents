import { useEffect, useRef, useState } from 'preact/hooks'
import { api, Bot, EnvEntry } from '../api'
import { CopyChip, Flash, Section, StatusDot, fmtUptime, shortNpub } from './ui'

export function BotDetail({ name }: { name: string; path?: string }) {
  const [bot, setBot] = useState<Bot | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const refresh = () =>
    api.bots()
      .then((bots) => {
        const b = bots.find((x) => x.name === name)
        if (!b) throw new Error(`unknown bot: ${name}`)
        setBot(b)
      })
      .catch((e) => setError(e.message))

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [name])

  if (!bot) {
    return error
      ? <Flash kind="err" text={error} />
      : <div class="lc-card h-64 lc-skeleton" />
  }

  return (
    <div class="animate-fade-in-up">
      <div class="flex items-center gap-3 mb-6 flex-wrap">
        <StatusDot status={bot.status} />
        <h1 class="text-2xl font-extrabold">{bot.name}</h1>
        <span class="text-sm text-lc-muted">
          {bot.script} · up {fmtUptime(bot.uptime)} · {bot.restarts} restarts
        </span>
        {bot.npub && <CopyChip text={bot.npub} label={shortNpub(bot.npub)} />}
      </div>

      <Flash kind="err" text={error} />
      <Flash kind="ok" text={flash} />

      <EnvSection bot={bot} onSaved={(msg) => { setFlash(msg); refresh() }} onError={setError} />
      <ProfileSection bot={bot} onDone={setFlash} onError={setError} />
      <LogsSection name={bot.name} />
    </div>
  )
}

// ── Per-bot settings: exactly the env vars this bot's source reads ──────
function EnvSection({ bot, onSaved, onError }: {
  bot: Bot
  onSaved: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const dirty = Object.keys(edits).length > 0

  const save = async (restart: boolean) => {
    setBusy(true)
    onError('')
    try {
      await api.saveEnv(edits)
      if (restart) await api.botAction(bot.name, 'restart')
      setEdits({})
      onSaved(restart ? 'Settings saved — bot restarted with the new config.' : 'Settings saved. Restart the bot to apply.')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = (entry: EnvEntry) => {
    const edited = edits[entry.key]
    return (
      <input
        class="lc-input font-mono text-xs"
        type={entry.secret ? 'password' : 'text'}
        placeholder={entry.secret ? (entry.set ? '•••••• (set — type to replace)' : 'not set') : ''}
        value={edited ?? (entry.secret ? '' : entry.value ?? '')}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value
          setEdits((prev) => ({ ...prev, [entry.key]: v }))
        }}
      />
    )
  }

  return (
    <Section
      title="Settings"
      actions={
        dirty && (
          <div class="flex gap-2">
            <button class="lc-pill-secondary text-xs !py-1.5" disabled={busy} onClick={() => save(false)}>Save</button>
            <button class="lc-pill-primary text-xs !py-1.5" disabled={busy} onClick={() => save(true)}>
              {busy ? '…' : 'Save + restart'}
            </button>
          </div>
        )
      }
    >
      <p class="text-xs text-lc-muted mb-4">
        Every env var this bot reads, straight from <code class="text-lc-green">.env.local</code>.
        Relay lists and group lists are comma-separated (<span class="font-mono">wss://relay|groupId</span> for groups).
      </p>
      <div class="grid gap-3 md:grid-cols-2">
        {bot.envVars.map((entry) => (
          <label key={entry.key} class="block">
            <span class="text-xs font-mono text-lc-muted flex justify-between mb-1">
              {entry.key}
              {entry.secret && <span class="text-lc-green/70">{entry.set ? 'secret · set' : 'secret · empty'}</span>}
            </span>
            {input(entry)}
          </label>
        ))}
      </div>
    </Section>
  )
}

// ── Profile (kind 0) ────────────────────────────────────────────────────
function ProfileSection({ bot, onDone, onError }: {
  bot: Bot
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [p, setP] = useState({ name: '', display_name: '', about: '', picture: '' })
  const [busy, setBusy] = useState(false)

  const publish = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    onError('')
    try {
      const body = Object.fromEntries(Object.entries(p).filter(([, v]) => v.trim() !== ''))
      const { output } = await api.publishProfile(bot.name, body)
      onDone(`Profile published: ${output.split('\n').pop()}`)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof typeof p, label: string, placeholder: string) => (
    <label class="block">
      <span class="text-xs text-lc-muted block mb-1">{label}</span>
      <input
        class="lc-input"
        placeholder={placeholder}
        value={p[key]}
        onInput={(e) => setP((prev) => ({ ...prev, [key]: (e.target as HTMLInputElement).value }))}
      />
    </label>
  )

  return (
    <Section title="Profile (kind 0)">
      <p class="text-xs text-lc-muted mb-4">
        Publishes via <code class="text-lc-green">tools/set-profile.mjs</code> with this bot's key.
        Empty fields are left untouched.
      </p>
      <form class="grid gap-3 md:grid-cols-2" onSubmit={publish}>
        {field('name', 'Name', 'price-bot')}
        {field('display_name', 'Display name', 'BTC $109,431')}
        {field('picture', 'Picture URL', 'https://…/avatar.png')}
        {field('about', 'About', 'What this bot does')}
        <div class="md:col-span-2">
          <button class="lc-pill-primary text-sm" disabled={busy}>
            {busy ? <span class="lc-spinner" /> : 'Publish profile'}
          </button>
        </div>
      </form>
    </Section>
  )
}

// ── Logs ────────────────────────────────────────────────────────────────
function LogsSection({ name }: { name: string }) {
  const [logs, setLogs] = useState<{ out: string[]; err: string[] }>({ out: [], err: [] })
  const [follow, setFollow] = useState(true)
  const [tab, setTab] = useState<'out' | 'err'>('out')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const tick = () => api.botLogs(name).then((l) => { if (alive) setLogs(l) }).catch(() => {})
    tick()
    const t = setInterval(() => follow && tick(), 3000)
    return () => { alive = false; clearInterval(t) }
  }, [name, follow])

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [logs, follow])

  return (
    <Section
      title="Logs"
      actions={
        <div class="flex gap-2 items-center">
          {(['out', 'err'] as const).map((t) => (
            <button
              key={t}
              class={`px-3 py-1 rounded-full text-xs font-medium ${
                tab === t ? 'bg-lc-olive-dark text-lc-green' : 'text-lc-muted hover:text-lc-white'
              }`}
              onClick={() => setTab(t)}
            >
              std{t} {t === 'err' && logs.err.length > 0 ? `(${logs.err.length})` : ''}
            </button>
          ))}
          <label class="text-xs text-lc-muted flex items-center gap-1.5 ml-2 cursor-pointer">
            <input type="checkbox" checked={follow} onChange={() => setFollow(!follow)} class="accent-[#b4f953]" />
            follow
          </label>
        </div>
      }
    >
      <div ref={boxRef} class="lc-console h-80">
        {(logs[tab].length ? logs[tab] : ['(empty)']).join('\n')}
      </div>
    </Section>
  )
}
