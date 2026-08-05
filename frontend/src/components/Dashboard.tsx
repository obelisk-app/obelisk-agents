import { useEffect, useState } from 'preact/hooks'
import { route } from 'preact-router'
import { api, ActivityRun, AgentStatus, Bot, Script } from '../api'
import { toast } from './toast'
import { CopyChip, Section, StatusDot, fmtMem, fmtUptime, shortNpub, timeAgo } from './ui'

export function Dashboard(_props: { path?: string }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [busy, setBusy] = useState('')
  const [wizard, setWizard] = useState(false)

  const refresh = () => api.bots().then(setBots).catch((e) => toast.err(e.message))

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const act = async (name: string, action: 'start' | 'stop' | 'restart') => {
    setBusy(name + action)
    try {
      await api.botAction(name, action)
      toast.ok(`${name.replace(/^obelisk-/, '')} ${action}${action === 'stop' ? 'ped' : 'ed'}`)
      await refresh()
    } catch (e) {
      toast.err((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const online = bots?.filter((b) => b.status === 'online').length ?? 0

  return (
    <div class="animate-fade-in-up">
      <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 class="text-2xl font-extrabold">Bot fleet</h1>
          <p class="text-sm text-lc-muted mt-0.5">
            {bots ? (
              <>
                <span class={online > 0 ? 'text-lc-green' : ''}>{online} online</span>
                {' · '}{(bots.length - online)} stopped · {bots.reduce((n, b) => n + b.restarts, 0)} restarts total
              </>
            ) : 'loading…'}
          </p>
        </div>
        <button class="lc-pill-primary" onClick={() => setWizard(true)}>+ New bot</button>
      </div>

      {bots === null ? (
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <div key={i} class="lc-card h-48 lc-skeleton" />)}
        </div>
      ) : (
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <BotCard key={bot.name} bot={bot} busy={busy} onAct={act} />
          ))}
        </div>
      )}

      <ActivityFeed />
      <ScriptsInventory />

      {wizard && <NewBotWizard onClose={() => setWizard(false)} onDone={refresh} />}
    </div>
  )
}

// ── Operator activity: every command the AI ran, every file it touched ──
function ActivityFeed() {
  const [runs, setRuns] = useState<ActivityRun[] | null>(null)

  useEffect(() => {
    const tick = () => api.activity().then(setRuns).catch(() => {})
    tick()
    const t = setInterval(tick, 6000)
    return () => clearInterval(t)
  }, [])

  if (!runs?.length) return null

  return (
    <div class="mt-8">
      <Section title="Operator activity">
        <p class="text-xs text-lc-muted mb-3">
          What the AI actually did — every shell command and file change, per run. Live runs update as they work.
        </p>
        <div class="space-y-2">
          {runs.map((run) => (
            <details key={run.id} class="border border-lc-border rounded-lg overflow-hidden">
              <summary class="flex items-center gap-3 px-3 py-2 cursor-pointer select-none hover:bg-lc-card text-sm">
                <span class={`lc-dot ${run.status === 'running' ? 'lc-dot-online' : run.status === 'done' ? 'lc-dot-stopped' : 'lc-dot-errored'}`} />
                <span class="flex-1 truncate">{run.prompt.split('\n')[0].slice(0, 90)}</span>
                <span class="text-xs text-lc-muted whitespace-nowrap">
                  {run.commands.length} cmd{run.commands.length === 1 ? '' : 's'}
                  {run.files.length > 0 && ` · ${run.files.length} file${run.files.length === 1 ? '' : 's'}`}
                  {' · '}{run.status === 'running' ? 'running now' : timeAgo(run.startedAt)}
                </span>
              </summary>
              <div class="px-3 pb-3 pt-1 space-y-3">
                {run.files.length > 0 && (
                  <div class="flex flex-wrap gap-1.5">
                    {run.files.map((f) => (
                      <span key={f} class="text-[11px] font-mono bg-lc-olive-dark/60 text-lc-green rounded px-2 py-0.5">{f}</span>
                    ))}
                  </div>
                )}
                {run.commands.length > 0 && (
                  <div class="lc-console max-h-72">
                    {run.commands.map((c, i) => (
                      <div key={i} class="mb-2">
                        <div class={c.exitCode === 0 || c.exitCode == null ? 'text-lc-green' : 'lc-log-err'}>
                          $ {c.command}{c.exitCode != null && c.exitCode !== 0 ? `   (exit ${c.exitCode})` : ''}
                        </div>
                        {c.output && <div class="text-lc-muted">{c.output}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {run.lastMessage && (
                  <div class="text-xs text-lc-muted border-l-2 border-lc-olive pl-2 whitespace-pre-wrap">{run.lastMessage}</div>
                )}
                {run.commands.length === 0 && run.files.length === 0 && !run.lastMessage && (
                  <div class="text-xs text-lc-muted">nothing logged yet…</div>
                )}
              </div>
            </details>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ── Workspace scripts: what's on disk, and what the AI added/changed ────
function ScriptsInventory() {
  const [scripts, setScripts] = useState<Script[] | null>(null)

  useEffect(() => {
    const tick = () => api.scripts().then(setScripts).catch(() => {})
    tick()
    const t = setInterval(tick, 10000)
    return () => clearInterval(t)
  }, [])

  if (!scripts?.length) return null

  return (
    <Section title="Workspace scripts">
      <p class="text-xs text-lc-muted mb-3">
        Every script in the repo, newest first. <span class="text-lc-green">new</span>/<span class="text-yellow-400">modified</span> = not committed yet (usually the operator's work).
      </p>
      <div class="grid gap-1.5 sm:grid-cols-2">
        {scripts.map((s) => (
          <div key={s.file} class="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-lc-card border border-lc-border">
            <span class="font-mono flex-1 truncate" title={s.file}>{s.file}</span>
            {s.git === 'new' && <span class="text-[10px] font-bold bg-lc-olive-dark text-lc-green rounded px-1.5 py-0.5">NEW</span>}
            {s.git === 'modified' && <span class="text-[10px] font-bold bg-yellow-950 text-yellow-400 rounded px-1.5 py-0.5">MODIFIED</span>}
            <span class="text-lc-muted whitespace-nowrap">{(s.size / 1024).toFixed(1)}kB · {timeAgo(s.mtime)}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function BotCard({ bot, busy, onAct }: {
  bot: Bot
  busy: string
  onAct: (name: string, action: 'start' | 'stop' | 'restart') => void
}) {
  const [confirmStop, setConfirmStop] = useState(false)
  const short = bot.name.replace(/^obelisk-/, '')
  const initials = short.split('-').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  useEffect(() => {
    if (!confirmStop) return
    const t = setTimeout(() => setConfirmStop(false), 3000)
    return () => clearTimeout(t)
  }, [confirmStop])

  return (
    <div class="lc-card p-5 flex flex-col gap-3 cursor-pointer" onClick={() => route(`/bots/${bot.name}`)}>
      <div class="flex items-center gap-3">
        <div class={`lc-monogram ${bot.status !== 'online' ? 'lc-monogram-off' : ''}`}>
          {bot.kind === 'agent' ? '✦' : initials}
        </div>
        <div class="min-w-0">
          <div class="font-bold truncate flex items-center gap-2">
            {short}
            {bot.kind === 'agent' && (
              <span class="text-[10px] font-bold tracking-wider bg-lc-olive-dark text-lc-green rounded px-1.5 py-0.5">
                AGENT
              </span>
            )}
          </div>
          <div class="text-xs text-lc-muted flex items-center gap-1.5">
            <StatusDot status={bot.status} /> {bot.status} · {fmtUptime(bot.uptime)}
          </div>
        </div>
      </div>

      <div class="text-xs text-lc-muted space-y-1" onClick={(e) => e.stopPropagation()}>
        <div class="flex justify-between">
          <span>identity</span>
          {bot.npub
            ? <CopyChip text={bot.npub} label={shortNpub(bot.npub)} />
            : <span class="text-red-400">no nsec ({bot.nsecEnv})</span>}
        </div>
        <div class="flex justify-between"><span>restarts</span><span>{bot.restarts}</span></div>
        <div class="flex justify-between"><span>cpu / mem</span><span>{bot.cpu ?? 0}% / {fmtMem(bot.memory)}</span></div>
      </div>

      {bot.lastLog && (
        <div class="text-[11px] font-mono text-lc-muted/70 truncate border-t border-lc-border pt-2" title={bot.lastLog}>
          {bot.lastLog}
        </div>
      )}

      <div class="flex gap-2 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
        {bot.status === 'online' ? (
          <>
            <button class="lc-pill-secondary text-xs !px-3 !py-1.5" disabled={!!busy}
              onClick={() => onAct(bot.name, 'restart')}>
              {busy === bot.name + 'restart' ? '…' : 'Restart'}
            </button>
            <button class="lc-pill-danger text-xs !px-3 !py-1.5" disabled={!!busy}
              onClick={() => confirmStop ? onAct(bot.name, 'stop') : setConfirmStop(true)}>
              {busy === bot.name + 'stop' ? '…' : confirmStop ? 'Sure?' : 'Stop'}
            </button>
          </>
        ) : (
          <button class="lc-pill-primary text-xs !px-3 !py-1.5" disabled={!!busy}
            onClick={() => onAct(bot.name, 'start')}>
            {busy === bot.name + 'start' ? '…' : 'Start'}
          </button>
        )}
        <span class="ml-auto text-xs text-lc-muted self-center">Manage →</span>
      </div>
    </div>
  )
}

// ── New bot wizard ──────────────────────────────────────────────────────
// Scaffold + optionally hand the described behavior straight to the
// Operator (Codex) which implements automations, scraping and chat
// interactions against the chosen relays/groups.
function NewBotWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'bot' | 'agent'>('bot')
  const [description, setDescription] = useState('')
  const [relays, setRelays] = useState('wss://public.obelisk.ar')
  const [groups, setGroups] = useState('')
  const [allowed, setAllowed] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [build, setBuild] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.agentStatus().then(setAgent).catch(() => setAgent(null))
  }, [])

  const codexReady = !!agent && agent.mode !== 'none'

  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const created = await api.scaffold({
        name: name.trim(),
        kind,
        description: description.trim(),
        relays: relays.split(',').map((s) => s.trim()).filter(Boolean),
        groups: groups.split(',').map((s) => s.trim()).filter(Boolean),
        allowedPubkeys: allowed.split(',').map((s) => s.trim()).filter(Boolean),
        systemPrompt: systemPrompt.trim(),
        build: build && codexReady,
      })
      onDone()
      onClose()
      if (created.runId) {
        toast.ok(`${created.name} scaffolded — Codex is building it now`)
        route(`/operator?run=${created.runId}`)
      } else {
        toast.ok(`${created.name} scaffolded (${shortNpub(created.npub)}). Whitelist the npub, edit the code, then start it.`)
      }
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="lc-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form class="lc-card lc-modal p-6" onSubmit={submit}>
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-lg font-bold">New bot</h2>
          <button type="button" class="text-lc-muted hover:text-lc-white text-xl leading-none" onClick={onClose}>×</button>
        </div>
        <p class="text-xs text-lc-muted mb-5">
          Generates an identity (nsec straight into <code>.env.local</code>), a starter file under{' '}
          <code>bots/</code>, a PM2 entry, and the relay/group config below.
        </p>

        <div class="space-y-4">
          <div class="grid md:grid-cols-2 gap-4 items-end">
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">Name</span>
              <input class="lc-input" placeholder={kind === 'agent' ? 'helper-agent' : 'welcome-bot'} value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)} required />
            </label>
            <div>
              <span class="text-xs text-lc-muted block mb-1">Type</span>
              <div class="lc-seg">
                <button type="button" class={kind === 'bot' ? 'active' : ''} onClick={() => setKind('bot')}>
                  Bot · scripted
                </button>
                <button type="button" class={kind === 'agent' ? 'active' : ''} onClick={() => setKind('agent')}>
                  ✦ Agent · LLM-powered
                </button>
              </div>
            </div>
          </div>

          {kind === 'agent' && (
            <p class="text-xs text-lc-muted -mt-1">
              An agent chats through an LLM (Anthropic or any OpenAI-compatible API — set{' '}
              <code>ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code> in Settings) and{' '}
              <span class="text-lc-green">only hears whitelisted users</span>. Empty whitelist
              defaults to you (the admin).
            </p>
          )}

          <label class="block">
            <span class="text-xs text-lc-muted block mb-1">What should it do?</span>
            <textarea class="lc-input h-24 resize-y text-sm"
              placeholder={kind === 'agent'
                ? 'e.g. "You are the group\'s bitcoin research assistant. Answer questions with sources, track topics people ask about, stay concise."'
                : 'e.g. "Greet every user who joins a group with a short welcome and a link to the rules. Also answer !rules. If someone zaps the group, react with ⚡."'}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
          </label>

          {kind === 'agent' && (
            <div class="grid md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs text-lc-muted block mb-1">Whitelisted npubs (comma-separated)</span>
                <input class="lc-input font-mono text-xs" placeholder="npub1… (empty = just you)"
                  value={allowed} onInput={(e) => setAllowed((e.target as HTMLInputElement).value)} />
              </label>
              <label class="block">
                <span class="text-xs text-lc-muted block mb-1">System prompt (persona)</span>
                <input class="lc-input text-xs" placeholder="You are a concise, friendly research assistant…"
                  value={systemPrompt} onInput={(e) => setSystemPrompt((e.target as HTMLInputElement).value)} />
              </label>
            </div>
          )}

          <div class="grid md:grid-cols-2 gap-4">
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">Relays (comma-separated)</span>
              <input class="lc-input font-mono text-xs" value={relays}
                onInput={(e) => setRelays((e.target as HTMLInputElement).value)} />
            </label>
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">
                Groups (<span class="font-mono">wss://relay|id</span>, find ids in Settings)
              </span>
              <input class="lc-input font-mono text-xs" placeholder="wss://public.obelisk.ar|abc123"
                value={groups} onInput={(e) => setGroups((e.target as HTMLInputElement).value)} />
            </label>
          </div>

          <label class={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
            build && codexReady ? 'border-lc-olive bg-lc-olive-dark/40' : 'border-lc-border'
          }`}>
            <input type="checkbox" class="accent-[#b4f953] mt-0.5" checked={build && codexReady}
              disabled={!codexReady} onChange={() => setBuild(!build)} />
            <span class="text-xs">
              <span class="font-semibold text-sm block mb-0.5">
                Build it with Codex{' '}
                {agent === null ? '…' : codexReady
                  ? <span class="text-lc-green">({agent.mode === 'chatgpt' ? `subscription · ${agent.plan ?? 'chatgpt'}` : 'API credits'})</span>
                  : <span class="text-red-400">(not connected — see Operator)</span>}
              </span>
              <span class="text-lc-muted">
                Hands your description to the Operator, which implements the bot (interactions,
                scraping/data sources, intervals) following docs/building-bots.md, tests it foreground
                and restarts it. You can watch and interrupt the run.
              </span>
            </span>
          </label>
        </div>

        <div class="flex justify-end gap-2 mt-6">
          <button type="button" class="lc-pill-secondary text-sm" onClick={onClose}>Cancel</button>
          <button class="lc-pill-primary text-sm" disabled={busy || !name.trim()}>
            {busy ? <span class="lc-spinner" /> : build && codexReady ? 'Scaffold + build' : 'Scaffold'}
          </button>
        </div>
      </form>
    </div>
  )
}
