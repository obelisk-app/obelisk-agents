import { useEffect, useRef, useState } from 'preact/hooks'
import { api, Bot, EnvEntry } from '../api'
import { Section as SettingsSection, metaFor, SECTION_TITLES } from '../settings-meta'
import { SettingField } from './fields'
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
      <a href="/" class="text-xs text-lc-muted hover:text-lc-green transition-colors">← fleet</a>
      <div class="flex items-center gap-3 mb-6 mt-2 flex-wrap">
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

// ── Per-bot settings: semantic form built from the vars this bot reads ──
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

  const valueOf = (entry: EnvEntry) => edits[entry.key] ?? (entry.secret ? '' : entry.value ?? '')
  const relaysEntry = bot.envVars.find((e) => /_RELAYS$/.test(e.key) && !/_LISTEN_RELAYS$/.test(e.key))
  const relaysHint = (relaysEntry && valueOf(relaysEntry)) || 'wss://relay.obelisk.ar'

  const grouped = new Map<SettingsSection, EnvEntry[]>()
  for (const entry of bot.envVars) {
    const section = metaFor(entry.key).section
    grouped.set(section, [...(grouped.get(section) ?? []), entry])
  }

  const renderField = (entry: EnvEntry) => (
    <SettingField
      key={entry.key}
      envKey={entry.key}
      meta={metaFor(entry.key)}
      value={valueOf(entry)}
      set={!!entry.set}
      secret={entry.secret}
      relaysHint={relaysHint}
      onChange={(v) => setEdits((prev) => ({ ...prev, [entry.key]: v }))}
    />
  )

  const order: SettingsSection[] = ['identity', 'connection', 'behavior', 'llm']

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
      {order.map((section) => {
        const entries = grouped.get(section)
        if (!entries?.length) return null
        return (
          <div key={section} class="mb-5">
            <h3 class="text-xs font-bold uppercase tracking-wider text-lc-muted mb-1">
              {SECTION_TITLES[section]}
            </h3>
            {entries.map(renderField)}
          </div>
        )
      })}
      {(grouped.get('advanced')?.length ?? 0) > 0 && (
        <details>
          <summary class="text-xs font-bold uppercase tracking-wider text-lc-muted cursor-pointer select-none hover:text-lc-white">
            Advanced
          </summary>
          <div class="mt-1">{grouped.get('advanced')!.map(renderField)}</div>
        </details>
      )}
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
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Picture flow: browser → manager → Blossom upload signed with the BOT's
  // key → merged kind 0 published to relays. One click, live everywhere.
  const uploadPicture = async (file: File) => {
    setUploading(true)
    onError('')
    try {
      const { url } = await api.uploadAvatar(bot.name, file)
      setP((prev) => ({ ...prev, picture: url }))
      onDone(`Picture uploaded and profile published — ${url}`)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

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
        <div class="block">
          <span class="text-xs text-lc-muted block mb-1">Picture</span>
          <div class="flex gap-2">
            <input
              class="lc-input"
              placeholder="https://…/avatar.png — or upload →"
              value={p.picture}
              onInput={(e) => setP((prev) => ({ ...prev, picture: (e.target as HTMLInputElement).value }))}
            />
            <button type="button" class="lc-pill-secondary text-xs whitespace-nowrap" disabled={uploading}
              onClick={() => fileRef.current?.click()}>
              {uploading ? <span class="lc-spinner" /> : '⬆ Upload'}
            </button>
            <input ref={fileRef} type="file" accept="image/*" class="hidden"
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) uploadPicture(file)
              }} />
          </div>
          <span class="text-[11px] text-lc-muted/70 block mt-1">
            Uploads to Blossom signed with the bot's key, then publishes the profile instantly.
          </span>
        </div>
        {field('about', 'About', 'What this bot does')}
        {p.picture && (
          <img src={p.picture} alt="avatar preview"
            class="w-16 h-16 rounded-xl object-cover border border-lc-border md:col-span-2" />
        )}
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
        {(logs[tab].length ? logs[tab] : ['(empty)']).map((line, i) => (
          <div key={i} class={
            /error|exception|fatal|ECONN|refused/i.test(line) ? 'lc-log-err'
              : /warn/i.test(line) ? 'lc-log-warn'
              : /EOSE|running as|listening/.test(line) ? undefined
              : undefined
          }>{line}</div>
        ))}
      </div>
    </Section>
  )
}
