import { useEffect, useState } from 'preact/hooks'
import { route } from 'preact-router'
import { api, Bot } from '../api'
import { CopyChip, Flash, StatusDot, fmtMem, fmtUptime, shortNpub } from './ui'

export function Dashboard(_props: { path?: string }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [newName, setNewName] = useState('')
  const [flash, setFlash] = useState('')

  const refresh = () => api.bots().then(setBots).catch((e) => setError(e.message))

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const act = async (name: string, action: 'start' | 'stop' | 'restart') => {
    setBusy(name + action)
    setError('')
    try {
      await api.botAction(name, action)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const scaffold = async (e: Event) => {
    e.preventDefault()
    if (!newName.trim()) return
    setBusy('scaffold')
    setError('')
    try {
      const created = await api.scaffold(newName.trim())
      setFlash(`Scaffolded ${created.name} (${shortNpub(created.npub)}) — nsec saved to .env.local, PM2 entry added. Whitelist the npub on the relay, then start it.`)
      setNewName('')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div class="animate-fade-in-up">
      <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 class="text-2xl font-extrabold">
          Bot fleet <span class="text-lc-muted font-normal text-base">· one process per bot, PM2-supervised</span>
        </h1>
        <form class="flex gap-2" onSubmit={scaffold}>
          <input
            class="lc-input w-44"
            placeholder="new-bot-name"
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          />
          <button class="lc-pill-secondary whitespace-nowrap" disabled={busy === 'scaffold'}>
            {busy === 'scaffold' ? <span class="lc-spinner" /> : '+ Scaffold bot'}
          </button>
        </form>
      </div>

      <Flash kind="err" text={error} />
      <Flash kind="ok" text={flash} />

      {bots === null ? (
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <div key={i} class="lc-card h-44 lc-skeleton" />)}
        </div>
      ) : (
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <div key={bot.name} class="lc-card p-5 flex flex-col gap-3">
              <div class="flex items-center gap-3">
                <StatusDot status={bot.status} />
                <button
                  class="font-bold text-left hover:text-lc-green transition-colors truncate"
                  onClick={() => route(`/bots/${bot.name}`)}
                >
                  {bot.name.replace(/^obelisk-/, '')}
                </button>
                <span class="ml-auto text-xs text-lc-muted">{bot.status}</span>
              </div>

              <div class="text-xs text-lc-muted space-y-1">
                <div class="flex justify-between">
                  <span>identity</span>
                  {bot.npub
                    ? <CopyChip text={bot.npub} label={shortNpub(bot.npub)} />
                    : <span class="text-red-400">no nsec ({bot.nsecEnv})</span>}
                </div>
                <div class="flex justify-between"><span>uptime</span><span>{fmtUptime(bot.uptime)}</span></div>
                <div class="flex justify-between"><span>restarts</span><span>{bot.restarts}</span></div>
                <div class="flex justify-between"><span>cpu / mem</span><span>{bot.cpu ?? 0}% / {fmtMem(bot.memory)}</span></div>
              </div>

              <div class="flex gap-2 mt-auto pt-2">
                {bot.status === 'online' ? (
                  <>
                    <button class="lc-pill-secondary text-xs !px-3 !py-1.5" disabled={!!busy}
                      onClick={() => act(bot.name, 'restart')}>
                      {busy === bot.name + 'restart' ? '…' : 'Restart'}
                    </button>
                    <button class="lc-pill-danger text-xs !px-3 !py-1.5" disabled={!!busy}
                      onClick={() => act(bot.name, 'stop')}>
                      {busy === bot.name + 'stop' ? '…' : 'Stop'}
                    </button>
                  </>
                ) : (
                  <button class="lc-pill-primary text-xs !px-3 !py-1.5" disabled={!!busy}
                    onClick={() => act(bot.name, 'start')}>
                    {busy === bot.name + 'start' ? '…' : 'Start'}
                  </button>
                )}
                <button
                  class="ml-auto text-xs text-lc-muted hover:text-lc-green transition-colors"
                  onClick={() => route(`/bots/${bot.name}`)}
                >
                  Manage →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
