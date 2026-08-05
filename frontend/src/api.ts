// Thin client for the manager API. Cookies carry the session.

export interface EnvEntry {
  key: string
  secret: boolean
  value?: string
  set?: boolean
}

export interface BotCommand {
  command: string
  description: string | null
  example: string | null
}

export interface Bot {
  name: string
  kind: 'bot' | 'agent'
  commands: BotCommand[]
  script: string
  status: string
  pid: number | null
  uptime: number | null
  restarts: number
  cpu: number | null
  memory: number | null
  nsecEnv: string
  npub: string | null
  envVars: EnvEntry[]
  lastLog: string | null
}

export interface AgentStatus {
  installed: boolean
  version: string | null
  mode: 'chatgpt' | 'apikey' | 'none'
  hasSubscription?: boolean
  hasApiKey?: boolean
  email?: string | null
  plan?: string | null
  lastRefresh?: string | null
}

export interface RunMeta {
  id: string
  prompt: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'failed'
  exitCode?: number | null
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export const api = {
  session: () => req<{ authed: boolean; npub?: string }>('/api/auth/session'),
  challenge: () => req<{ challenge: string }>('/api/auth/challenge'),
  login: (event: object) =>
    req<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ event }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  bots: () => req<Bot[]>('/api/bots'),
  scaffold: (opts: {
    name: string
    kind?: 'bot' | 'agent'
    description?: string
    relays?: string[]
    groups?: string[]
    allowedPubkeys?: string[]
    systemPrompt?: string
    build?: boolean
  }) =>
    req<{ name: string; npub: string; runId: string | null }>('/api/bots', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  botAction: (name: string, action: 'start' | 'stop' | 'restart') =>
    req<{ ok: boolean }>(`/api/bots/${name}/${action}`, { method: 'POST' }),
  removeBot: (name: string) =>
    req<{ removed: string }>(`/api/bots/${name}`, { method: 'DELETE' }),
  botLogs: (name: string, lines = 200) =>
    req<{ out: string[]; err: string[] }>(`/api/bots/${name}/logs?lines=${lines}`),
  publishProfile: (name: string, profile: object) =>
    req<{ output: string }>(`/api/bots/${name}/profile`, { method: 'POST', body: JSON.stringify(profile) }),

  env: () => req<EnvEntry[]>('/api/env'),
  saveEnv: (set: Record<string, string>, unset: string[] = []) =>
    req<{ ok: boolean; entries: EnvEntry[] }>('/api/env', {
      method: 'PUT',
      body: JSON.stringify({ set, unset }),
    }),

  // Raw image body — the manager signs a Blossom upload with the bot's key
  // and publishes the merged kind 0.
  uploadAvatar: async (name: string, file: File) => {
    const res = await fetch(`/api/bots/${name}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
    return body as { url: string; output: string }
  },

  groups: (relay: string) =>
    req<{ id: string; access: string; name: string }[]>(`/api/groups?relay=${encodeURIComponent(relay)}`),

  agentStatus: () => req<AgentStatus>('/api/agent/status'),
  agentApiKey: (key: string) =>
    req<AgentStatus>('/api/agent/api-key', { method: 'POST', body: JSON.stringify({ key }) }),
  agentLogout: () => req<AgentStatus>('/api/agent/logout', { method: 'POST' }),
  deviceAuthStart: () => req<DeviceAuth>('/api/agent/device-auth', { method: 'POST' }),
  deviceAuthStatus: () => req<DeviceAuth>('/api/agent/device-auth'),
  deviceAuthCancel: () => req<{ ok: boolean }>('/api/agent/device-auth', { method: 'DELETE' }),

  runs: () => req<RunMeta[]>('/api/agent/runs'),
  activity: () => req<ActivityRun[]>('/api/agent/activity'),
  scripts: () => req<Script[]>('/api/workspace/scripts'),
  startRun: (prompt: string) =>
    req<{ id: string }>('/api/agent/runs', { method: 'POST', body: JSON.stringify({ prompt }) }),
  killRun: (id: string) => req<{ ok: boolean }>(`/api/agent/runs/${id}/kill`, { method: 'POST' }),

  docs: () => req<string[]>('/api/docs'),
  doc: async (path: string) => {
    const res = await fetch(`/api/docs/${path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  },
}

export interface DeviceAuth {
  active: boolean
  done?: boolean
  ok?: boolean | null
  output?: string
}

export interface ActivityRun {
  id: string
  prompt: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt: number | null
  commands: { command: string; output: string; exitCode: number | null }[]
  files: string[]
  lastMessage: string | null
}

export interface Script {
  file: string
  size: number
  mtime: number
  git: 'new' | 'modified' | 'committed'
}
