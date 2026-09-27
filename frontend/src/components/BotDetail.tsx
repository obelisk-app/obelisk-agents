import { useEffect, useRef, useState } from 'preact/hooks'
import { route } from 'preact-router'
import { api, Bot, EnvEntry } from '../api'
import { toast } from './toast'
import { Section as SettingsSection, metaFor, SECTION_TITLES } from '../settings-meta'
import { SettingField } from './fields'
import { Avatar, CopyChip, Flash, Icon, Section, fmtMem, fmtUptime, profileMissing, profileName, shortNpub } from './ui'

type Tab = 'overview' | 'settings' | 'profile' | 'logs'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'profile', label: 'Nostr profile' },
  { id: 'logs', label: 'Logs' },
]

export function BotDetail({ name }: { name: string; path?: string }) {
  const [bot, setBot] = useState<Bot | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState('')
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.slice(1) as Tab
    return TABS.some((t) => t.id === h) ? h : 'overview'
  })

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

  const pick = (t: Tab) => {
    setTab(t)
    history.replaceState(null, '', `#${t}`)
  }

  const act = async (action: 'start' | 'stop' | 'restart') => {
    if (!bot) return
    setBusy(action)
    try {
      await api.botAction(bot.name, action)
      toast.ok(`${action === 'stop' ? 'Stopped' : action === 'start' ? 'Started' : 'Restarted'} ${bot.name.replace(/^obelisk-/, '')}`)
      await refresh()
    } catch (e) {
      toast.err((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  if (!bot) {
    return error
      ? <Flash kind="err" text={error} />
      : <div class="lc-card h-64 lc-skeleton" />
  }

  const short = bot.name.replace(/^obelisk-/, '')
  const title = profileName(bot.profile, short)
  const p = bot.profile

  return (
    <div class="animate-fade-in-up">
      <a href="/" class="text-xs text-lc-muted hover:text-lc-green transition-colors">← Fleet</a>

      <section class="lc-card overflow-hidden mt-3 mb-6">
        <div class="lc-bot-banner !h-32" style={p?.banner ? { backgroundImage: `url("${p.banner}")` } : undefined} />
        <div class="px-6 pb-6">
          <div class="flex flex-wrap items-end gap-4 -mt-12">
            <Avatar picture={p?.picture} label={short} size={96} status={bot.status} />
            <div class="min-w-0 flex-1 pb-1">
              <h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-2 flex-wrap">
                {title}
                {bot.kind === 'agent' && <span class="lc-tag">AGENT</span>}
              </h2>
              <div class="text-sm text-lc-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-mono">{bot.name}</span>
                <span>·</span>
                <span class={bot.status === 'online' ? 'text-lc-green' : bot.status === 'errored' ? 'text-red-400' : ''}>{bot.status}</span>
                {bot.status === 'online' && <><span>·</span><span>up {fmtUptime(bot.uptime)}</span></>}
              </div>
            </div>
            <div class="flex gap-2 pb-1">
              {bot.status === 'online' ? (
                <>
                  <button class="lc-pill-secondary text-sm gap-1.5" disabled={!!busy} onClick={() => act('restart')}>
                    <Icon.restart /> {busy === 'restart' ? '…' : 'Restart'}
                  </button>
                  <button class="lc-pill-danger text-sm gap-1.5" disabled={!!busy} onClick={() => act('stop')}>
                    <Icon.stop /> {busy === 'stop' ? '…' : 'Stop'}
                  </button>
                </>
              ) : (
                <button class="lc-pill-primary text-sm gap-1.5" disabled={!!busy} onClick={() => act('start')}>
                  <Icon.play /> {busy === 'start' ? '…' : 'Start'}
                </button>
              )}
            </div>
          </div>

          {p?.about && <p class="text-sm text-lc-muted mt-4 max-w-3xl whitespace-pre-line">{p.about}</p>}

          <div class="flex flex-wrap gap-1.5 mt-4 text-[11px]">
            {bot.npub
              ? <span class="lc-chip"><CopyChip text={bot.npub} label={shortNpub(bot.npub)} /></span>
              : <span class="lc-chip !text-red-400">no nsec ({bot.nsecEnv})</span>}
            {p?.nip05 && <span class="lc-chip">✓ {p.nip05}</span>}
            {p?.lud16 && <span class="lc-chip">⚡ {p.lud16}</span>}
            {bot.npub && (
              <a class="lc-chip hover:!text-lc-green" href={`https://njump.me/${bot.npub}`} target="_blank" rel="noreferrer">
                view on Nostr ↗
              </a>
            )}
            <span class="lc-chip font-mono">{bot.script}</span>
            <span class="lc-chip">{bot.cpu ?? 0}% cpu · {fmtMem(bot.memory)}</span>
            <span class="lc-chip">↻ {bot.restarts} restarts</span>
            {profileMissing(p) && (
              <button class="lc-chip !text-yellow-400 !border-yellow-900 hover:!border-yellow-600" onClick={() => pick('profile')}>
                ⚠ relays no longer have this profile — republish
              </button>
            )}
          </div>
        </div>

        <nav class="lc-tabs">
          {TABS.map((t) => (
            <button key={t.id} class={tab === t.id ? 'active' : ''} onClick={() => pick(t.id)}>{t.label}</button>
          ))}
        </nav>
      </section>

      <Flash kind="err" text={error} />
      <Flash kind="ok" text={flash} />

      {tab === 'overview' && (
        <>
          <CommandsSection bot={bot} />
          <DangerZone bot={bot} />
        </>
      )}
      {tab === 'settings' && <EnvSection bot={bot} onSaved={(msg) => { setFlash(msg); refresh() }} onError={setError} />}
      {tab === 'profile' && <ProfileSection bot={bot} onDone={(msg) => { setFlash(msg); refresh() }} onError={setError} />}
      {tab === 'logs' && <LogsSection name={bot.name} />}
    </div>
  )
}

// ── Chat commands (from bots/<name>.commands.json, written at birth) ────
function CommandsSection({ bot }: { bot: Bot }) {
  return (
    <Section title="Chat commands">
      {bot.commands.length === 0 ? (
        <p class="text-sm text-lc-muted">
          {bot.kind === 'agent'
            ? 'No ! commands — this agent replies when mentioned (its npub or @name), or to every whitelisted message if "Replies to" is set to all.'
            : 'This bot has no chat commands — it acts on its own (announcements, tickers).'}
        </p>
      ) : (
        <div class="space-y-2">
          {bot.commands.map((c) => (
            <div key={c.command} class="flex items-baseline gap-3 flex-wrap">
              <code class="text-lc-green bg-lc-olive-dark/50 rounded px-2 py-0.5 text-sm font-semibold whitespace-nowrap">
                {c.command}
              </code>
              <span class="text-sm text-lc-muted flex-1 min-w-[200px]">
                {c.description ?? 'found in the code — no description yet (add it to the bot\'s .commands.json)'}
              </span>
              {c.example && c.example !== c.command && (
                <code class="text-[11px] text-lc-muted/70">{c.example}</code>
              )}
            </div>
          ))}
          <p class="text-[11px] text-lc-muted/60 pt-2 border-t border-lc-border/60">
            Type a command as a chat message in any group this bot is in. Declared in{' '}
            <code>{bot.script.replace('.mjs', '.commands.json')}</code> — kept current by Codex when
            it builds or edits the bot, or edit it by hand.
          </p>
        </div>
      )}
    </Section>
  )
}

// ── Danger zone ─────────────────────────────────────────────────────────
function DangerZone({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const short = bot.name.replace(/^obelisk-/, '')

  const remove = async () => {
    setBusy(true)
    try {
      await api.removeBot(bot.name)
      toast.ok(`${short} removed. Its script went to the trash folder and its keys stay commented in .env.local — nothing is unrecoverable.`)
      route('/')
    } catch (e) {
      toast.err((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <section class="rounded-xl border border-red-900/60 bg-red-950/20 p-5 mb-6">
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 class="font-bold text-red-300">Danger zone</h2>
          <p class="text-xs text-lc-muted mt-1 max-w-md">
            Removing stops the bot, deregisters it from PM2 and the ecosystem, moves its script to
            trash, and comments out its keys (the nsec is kept recoverable — losing it would be forever).
          </p>
        </div>
        <button class="lc-pill-danger text-sm" onClick={() => setOpen(true)}>Remove this bot…</button>
      </div>

      {open && (
        <div class="lc-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div class="lc-card lc-modal p-6 !max-w-md border !border-red-900">
            <h3 class="font-bold text-red-300 mb-2">Remove {short}?</h3>
            <p class="text-xs text-lc-muted mb-4">
              It stops posting immediately and disappears from the fleet. Type{' '}
              <code class="text-red-300">{short}</code> to confirm.
            </p>
            <input
              class="lc-input font-mono text-sm mb-4"
              placeholder={short}
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
            <div class="flex justify-end gap-2">
              <button class="lc-pill-secondary text-sm" onClick={() => setOpen(false)}>Cancel</button>
              <button
                class="lc-pill-danger text-sm"
                disabled={busy || typed.trim() !== short}
                onClick={remove}
              >
                {busy ? <span class="lc-spinner" /> : 'Remove forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Per-bot settings: semantic form built from the vars this bot reads ──
function EnvSection({ bot, onSaved, onError }: {
  bot: Bot
  onSaved: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [savedOverlay, setSavedOverlay] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [busy, setBusy] = useState(false)

  // Autosave: every edit lands in .env.local ~1s after you stop typing —
  // nothing is ever lost. The bot picks changes up on restart.
  useEffect(() => {
    const keys = Object.keys(edits)
    if (!keys.length) return
    const timer = setTimeout(async () => {
      const batch = { ...edits }
      setSaveState('saving')
      try {
        await api.saveEnv(batch)
        setSavedOverlay((prev) => ({ ...prev, ...batch }))
        setEdits((prev) => {
          const next = { ...prev }
          for (const k of Object.keys(batch)) if (next[k] === batch[k]) delete next[k]
          return next
        })
        setSaveState('saved')
        setNeedsRestart(true)
      } catch (e) {
        setSaveState('idle')
        onError(`autosave failed: ${(e as Error).message}`)
      }
    }, 1200)
    return () => clearTimeout(timer)
  }, [edits])

  const restart = async () => {
    setBusy(true)
    try {
      await api.botAction(bot.name, 'restart')
      setNeedsRestart(false)
      onSaved('Restarted — the new settings are live.')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const valueOf = (entry: EnvEntry) =>
    edits[entry.key] ?? (entry.secret ? '' : savedOverlay[entry.key] ?? entry.value ?? '')
  const relaysEntry = bot.envVars.find((e) => /_RELAYS$/.test(e.key) && !/_LISTEN_RELAYS$/.test(e.key))
  const relaysHint = (relaysEntry && valueOf(relaysEntry)) || 'wss://public.obelisk.ar'

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
      botName={bot.name}
      onChange={(v) => setEdits((prev) => ({ ...prev, [entry.key]: v }))}
    />
  )

  const order: SettingsSection[] = ['identity', 'connection', 'behavior', 'llm']

  return (
    <Section
      title="Settings"
      actions={
        <div class="flex items-center gap-2">
          {(saveState === 'saving' || Object.keys(edits).length > 0) && (
            <span class="text-xs text-lc-muted flex items-center gap-1.5">
              <span class="lc-spinner !w-3 !h-3" /> saving…
            </span>
          )}
          {saveState === 'saved' && Object.keys(edits).length === 0 && (
            <span class="text-xs text-lc-green">✓ saved</span>
          )}
          {needsRestart && (
            <button class="lc-pill-primary text-xs !py-1.5" disabled={busy} onClick={restart}>
              {busy ? '…' : 'Restart to apply'}
            </button>
          )}
        </div>
      }
    >
      <p class="text-xs text-lc-muted mb-3 -mt-1">
        Changes <span class="text-lc-green">save automatically</span> as you edit; hit "Restart to
        apply" when you're done so the bot reloads them. These settings belong to this bot only —
        anything left empty falls back to the fleet-wide defaults on the{' '}
        <a href="/settings" class="text-lc-green hover:underline">Settings</a> page.
      </p>
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
const PROFILE_FIELDS = ['name', 'display_name', 'about', 'picture', 'banner', 'nip05', 'lud16', 'website'] as const
type ProfileForm = Record<(typeof PROFILE_FIELDS)[number], string>
const emptyProfile = () => Object.fromEntries(PROFILE_FIELDS.map((k) => [k, ''])) as ProfileForm

function ProfileSection({ bot, onDone, onError }: {
  bot: Bot
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [p, setP] = useState<ProfileForm>(emptyProfile)
  const [loaded, setLoaded] = useState(false)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Prefill with what's on the relays right now, so editing is editing.
  useEffect(() => {
    setLoaded(false)
    api.botProfile(bot.name)
      .then((current) => {
        setStale(!!current._stale)
        setP({ ...emptyProfile(), ...Object.fromEntries(
          PROFILE_FIELDS.map((k) => [k, typeof current[k] === 'string' ? current[k] : '']),
        ) })
      })
      .catch(() => {
        const cached = bot.profile
        if (cached) setP({ ...emptyProfile(), ...Object.fromEntries(PROFILE_FIELDS.map((k) => [k, cached[k] ?? ''])) })
      })
      .finally(() => setLoaded(true))
  }, [bot.name])

  // Picture flow: browser → manager → Blossom upload signed with the BOT's
  // key → merged kind 0 published to relays. One click, live everywhere.
  const uploadPicture = async (file: File) => {
    setUploading(true)
    onError('')
    try {
      const { url } = await api.uploadAvatar(bot.name, file)
      setP((prev) => ({ ...prev, picture: url }))
      onDone('Picture uploaded and profile published.')
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
      // Every field is sent: the server merges onto the live profile, and an
      // emptied field is cleared on purpose.
      const { output } = await api.publishProfile(bot.name, Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, v.trim()]),
      ))
      setStale(false)
      onDone(`Profile published — ${output.split('\n').pop()}`)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = (key: keyof ProfileForm) => (e: Event) =>
    setP((prev) => ({ ...prev, [key]: (e.target as HTMLInputElement).value }))

  const field = (key: keyof ProfileForm, label: string, placeholder: string) => (
    <label class="block">
      <span class="text-xs text-lc-muted block mb-1">{label}</span>
      <input class="lc-input" placeholder={placeholder} value={p[key]} onInput={set(key)} disabled={!loaded} />
    </label>
  )

  const short = bot.name.replace(/^obelisk-/, '')

  return (
    <div class="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
      <Section title="Nostr profile (kind 0)">
        <p class="text-xs text-lc-muted mb-4 -mt-1">
          Signed with this bot's own key and published to its relays. Only what you change is
          changed — the rest of the live profile is kept.
        </p>
        {stale && (
          <div class="rounded-lg px-4 py-2 text-xs mb-4 border bg-yellow-950/40 border-yellow-900 text-yellow-300">
            The relays no longer have this bot's profile — this is the last-known copy. Publish it to put it back.
          </div>
        )}
        {!loaded && <div class="flex items-center gap-2 text-xs text-lc-muted mb-3"><span class="lc-spinner !w-3 !h-3" /> loading the live profile…</div>}
        <form class="grid gap-3 md:grid-cols-2" onSubmit={publish}>
          {field('name', 'Name', 'price-bot')}
          {field('display_name', 'Display name', 'BTC $109,431')}
          <label class="block md:col-span-2">
            <span class="text-xs text-lc-muted block mb-1">About</span>
            <textarea class="lc-input h-24 resize-y" placeholder="What this bot does" value={p.about}
              onInput={set('about')} disabled={!loaded} />
          </label>
          <div class="block md:col-span-2">
            <span class="text-xs text-lc-muted block mb-1">Picture</span>
            <div class="flex gap-2">
              <input class="lc-input" placeholder="https://…/avatar.png — or upload →" value={p.picture}
                onInput={set('picture')} disabled={!loaded} />
              <button type="button" class="lc-pill-secondary text-xs whitespace-nowrap" disabled={uploading || !bot.npub}
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
          {field('banner', 'Banner', 'https://…/banner.jpg')}
          {field('website', 'Website', 'https://…')}
          {field('nip05', 'NIP-05', 'bot@obelisk.ar')}
          {field('lud16', 'Lightning address', 'bot@getalby.com')}
          <div class="md:col-span-2 flex items-center gap-3">
            <button class="lc-pill-primary text-sm" disabled={busy || !loaded || !bot.npub}>
              {busy ? <span class="lc-spinner" /> : 'Publish profile'}
            </button>
            {!bot.npub && <span class="text-xs text-red-400">This bot has no nsec configured.</span>}
          </div>
        </form>
      </Section>

      {/* Live preview of how clients will render it */}
      <div class="lc-card overflow-hidden lg:sticky lg:top-6">
        <div class="lc-bot-banner !h-20" style={p.banner ? { backgroundImage: `url("${p.banner}")` } : undefined} />
        <div class="px-4 pb-4">
          <div class="-mt-8 mb-2"><Avatar picture={p.picture} label={short} size={64} rounded="full" /></div>
          <div class="font-bold">{p.display_name || p.name || short}</div>
          {p.nip05 && <div class="text-xs text-lc-green">✓ {p.nip05}</div>}
          <p class="text-xs text-lc-muted mt-2 whitespace-pre-line line-clamp-6">{p.about || 'No bio yet.'}</p>
          <div class="text-[10px] uppercase tracking-wider text-lc-muted/60 mt-3">Preview</div>
        </div>
      </div>
    </div>
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
