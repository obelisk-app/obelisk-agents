import { useEffect, useRef, useState } from 'preact/hooks'
import { api, AgentStatus, RunMeta } from '../api'
import { Flash, Section, timeAgo } from './ui'

export function Operator(_props: { path?: string }) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [error, setError] = useState('')

  const refresh = () => api.agentStatus().then(setStatus).catch((e) => setError(e.message))
  useEffect(() => { refresh() }, [])

  return (
    <div class="animate-fade-in-up">
      <h1 class="text-2xl font-extrabold mb-2">Operator</h1>
      <p class="text-lc-muted text-sm mb-6 max-w-2xl">
        An AI agent (Codex CLI) with shell access to this repo. It follows{' '}
        <a class="text-lc-green hover:underline" href="/docs/AGENTS.md">AGENTS.md</a> and{' '}
        <a class="text-lc-green hover:underline" href="/docs/docs%2Fbuilding-bots.md">docs/building-bots.md</a>{' '}
        — ask it to build a new bot, tweak one, or investigate a problem. Runs are sandboxed to the repo
        (workspace-write).
      </p>
      <Flash kind="err" text={error} />
      {status && <AuthCard status={status} onChange={refresh} onError={setError} />}
      {status && status.mode !== 'none' && <RunPanel onError={setError} />}
    </div>
  )
}

// ── Credentials: Codex subscription or API credits ──────────────────────
function AuthCard({ status, onChange, onError }: {
  status: AgentStatus
  onChange: () => void
  onError: (e: string) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [device, setDevice] = useState<{ output: string; active: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  // Poll the device-auth flow while it is active.
  useEffect(() => {
    if (!device?.active) return
    const t = setInterval(async () => {
      const s = await api.deviceAuthStatus().catch(() => null)
      if (!s) return
      setDevice({ output: s.output ?? '', active: s.active })
      if (!s.active) onChange()
    }, 2000)
    return () => clearInterval(t)
  }, [device?.active])

  const startDevice = async () => {
    setBusy(true)
    onError('')
    try {
      const s = await api.deviceAuthStart()
      setDevice({ output: s.output ?? '', active: true })
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitKey = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    onError('')
    try {
      await api.agentApiKey(apiKey.trim())
      setApiKey('')
      setShowKeyInput(false)
      onChange()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const modeChip =
    status.mode === 'chatgpt' ? (
      <span class="bg-lc-olive-dark text-lc-green rounded-full px-3 py-1 text-xs font-semibold">
        Codex subscription{status.plan ? ` · ${status.plan}` : ''}
      </span>
    ) : status.mode === 'apikey' ? (
      <span class="bg-lc-olive-dark text-lc-green rounded-full px-3 py-1 text-xs font-semibold">
        API credits (OPENAI_API_KEY)
      </span>
    ) : (
      <span class="bg-red-950 text-red-300 rounded-full px-3 py-1 text-xs font-semibold">
        not connected
      </span>
    )

  return (
    <Section title="Credentials" actions={modeChip}>
      {!status.installed ? (
        <p class="text-sm text-red-300">Codex CLI is not installed on the server.</p>
      ) : (
        <div class="text-sm text-lc-muted space-y-1 mb-4">
          <div>{status.version}</div>
          {status.email && <div>Account: <span class="text-lc-white">{status.email}</span></div>}
          {status.lastRefresh && <div>Token refreshed: {new Date(status.lastRefresh).toLocaleString()}</div>}
        </div>
      )}

      <div class="flex gap-2 flex-wrap">
        <button class="lc-pill-secondary text-xs" disabled={busy || device?.active} onClick={startDevice}>
          {status.mode === 'chatgpt' ? 'Reconnect subscription' : 'Connect Codex subscription'}
        </button>
        <button class="lc-pill-secondary text-xs" disabled={busy} onClick={() => setShowKeyInput(!showKeyInput)}>
          Use API credits instead
        </button>
        {status.mode !== 'none' && (
          <button class="lc-pill-danger text-xs" disabled={busy}
            onClick={() => api.agentLogout().then(onChange).catch((e) => onError(e.message))}>
            Disconnect
          </button>
        )}
      </div>

      {showKeyInput && (
        <form class="flex gap-2 mt-4" onSubmit={submitKey}>
          <input class="lc-input font-mono text-xs" type="password" placeholder="sk-…"
            value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
          <button class="lc-pill-primary text-xs whitespace-nowrap" disabled={busy || !apiKey.trim()}>
            Save key
          </button>
        </form>
      )}

      {device && (
        <div class="mt-4">
          <div class="text-xs text-lc-muted mb-2">
            {device.active
              ? 'Open the link below and enter the code to authorize with your ChatGPT account:'
              : 'Device flow finished.'}
            {device.active && (
              <button class="ml-3 text-red-400 hover:underline"
                onClick={() => api.deviceAuthCancel().then(() => setDevice(null))}>
                cancel
              </button>
            )}
          </div>
          <div class="lc-console max-h-40">{device.output || 'starting…'}</div>
        </div>
      )}
    </Section>
  )
}

// ── Task runner ─────────────────────────────────────────────────────────
interface RunEvent {
  type: string
  [k: string]: unknown
}

function RunPanel({ onError }: { onError: (e: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const [runs, setRuns] = useState<RunMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [running, setRunning] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const refreshRuns = () => api.runs().then(setRuns).catch(() => {})
  useEffect(() => { refreshRuns() }, [])
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [events])

  const watch = (id: string) => {
    sourceRef.current?.close()
    setActiveId(id)
    setEvents([])
    const es = new EventSource(`/api/agent/runs/${id}/stream`)
    sourceRef.current = es
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RunEvent
      setEvents((prev) => [...prev, event])
      if (event.type === 'finished') {
        setRunning(false)
        es.close()
        refreshRuns()
      }
    }
    es.onerror = () => { es.close(); setRunning(false) }
  }

  const start = async (e: Event) => {
    e.preventDefault()
    if (!prompt.trim()) return
    onError('')
    setRunning(true)
    try {
      const { id } = await api.startRun(prompt.trim())
      setPrompt('')
      watch(id)
      refreshRuns()
    } catch (err) {
      setRunning(false)
      onError((err as Error).message)
    }
  }

  return (
    <>
      <Section title="Run a task">
        <form onSubmit={start}>
          <textarea
            class="lc-input font-mono text-xs h-24 resize-y"
            placeholder={'e.g. "Scaffold a welcome-bot that greets new members of every group it is in. Follow docs/building-bots.md, wire it into ecosystem.config.cjs, and test it compiles."'}
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          />
          <div class="flex gap-2 mt-3">
            <button class="lc-pill-primary text-sm" disabled={running || !prompt.trim()}>
              {running ? <span class="lc-spinner" /> : 'Run with Codex'}
            </button>
            {running && activeId && (
              <button type="button" class="lc-pill-danger text-sm"
                onClick={() => api.killRun(activeId).catch(() => {})}>
                Stop
              </button>
            )}
          </div>
        </form>
      </Section>

      {activeId && (
        <Section title={`Run ${activeId}`}>
          <div ref={boxRef} class="lc-console h-96">
            {events.map((event, i) => <EventLine key={i} event={event} />)}
            {events.length === 0 && <span class="text-lc-muted">waiting for output…</span>}
          </div>
        </Section>
      )}

      {runs.length > 0 && (
        <Section title="History">
          <div class="space-y-1">
            {runs.map((run) => (
              <button
                key={run.id}
                class={`w-full text-left flex gap-3 items-center px-3 py-2 rounded-lg text-xs transition-colors ${
                  run.id === activeId ? 'bg-lc-olive-dark' : 'hover:bg-lc-card'
                }`}
                onClick={() => watch(run.id)}
              >
                <span class={`lc-dot ${
                  run.status === 'running' ? 'lc-dot-online' : run.status === 'done' ? 'lc-dot-stopped' : 'lc-dot-errored'
                }`} />
                <span class="flex-1 truncate">{run.prompt}</span>
                <span class="text-lc-muted whitespace-nowrap">{run.status} · {timeAgo(run.startedAt)}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

// Render one codex exec --json event in a readable way; unknown shapes
// fall back to compact JSON so nothing is silently dropped.
function EventLine({ event }: { event: RunEvent }) {
  const item = event.item as { type?: string; text?: string; command?: string; aggregated_output?: string } | undefined

  if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message') {
      return <div class="text-lc-white whitespace-pre-wrap mb-2">{item.text}</div>
    }
    if (item.type === 'reasoning') {
      return <div class="text-lc-muted/70 italic mb-1">{item.text}</div>
    }
    if (item.type === 'command_execution') {
      return (
        <div class="mb-2">
          <div class="text-lc-green">$ {item.command}</div>
          {item.aggregated_output && (
            <div class="text-lc-muted">{item.aggregated_output.slice(0, 2000)}</div>
          )}
        </div>
      )
    }
  }
  if (event.type === 'item.started' || event.type === 'item.updated') return null
  if (event.type === 'turn.completed' || event.type === 'thread.started' || event.type === 'turn.started') {
    return <div class="text-lc-muted/60">— {event.type} —</div>
  }
  if (event.type === 'stderr' || event.type === 'raw') {
    return <div class="text-lc-muted/60">{String(event.text ?? '')}</div>
  }
  if (event.type === 'finished') {
    return (
      <div class={`font-semibold mt-2 ${event.status === 'done' ? 'text-lc-green' : 'text-red-400'}`}>
        ■ run {String(event.status)} (exit {String(event.exitCode ?? '?')})
      </div>
    )
  }
  return <div class="text-lc-muted/50">{JSON.stringify(event).slice(0, 500)}</div>
}
