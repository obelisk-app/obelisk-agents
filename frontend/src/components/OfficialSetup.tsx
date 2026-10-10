import { useState } from 'preact/hooks'
import { api, Bot } from '../api'
import { toast } from './toast'
import { shortNpub } from './ui'

// Turn on an official bot (official/catalog.json): give it an identity —
// a fresh one or the host's own nsec — plus relays/groups and its extra
// settings, then start it. The nsec goes straight into .env.local.
export function OfficialSetup({ bot, onClose, onDone }: { bot: Bot; onClose: () => void; onDone: () => void }) {
  const info = bot.official!
  const [identity, setIdentity] = useState<'generate' | 'paste'>('generate')
  const [nsec, setNsec] = useState('')
  const [relays, setRelays] = useState(info.defaults?.relays ?? 'wss://public.obelisk.ar')
  const [groups, setGroups] = useState('')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const split = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)

  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const done = await api.setupOfficial(info.id, {
        generate: identity === 'generate',
        nsec: identity === 'paste' ? nsec.trim() : '',
        relays: split(relays),
        groups: split(groups),
        env: extra,
        start: true,
      })
      toast.ok(`${info.title} is on as ${shortNpub(done.npub)}`)
      onDone()
      onClose()
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="lc-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form class="lc-card lc-modal p-6" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-lg font-bold">Turn on {info.title}</h2>
          <button type="button" class="text-lc-muted hover:text-lc-white text-xl leading-none" onClick={onClose}>×</button>
        </div>
        <p class="text-xs text-lc-muted mb-5">
          {info.description} The identity is stored in <code>.env.local</code> and never sent back to the browser.
        </p>

        <div class="space-y-4">
          <div>
            <span class="text-xs text-lc-muted block mb-1">Identity</span>
            <div class="lc-seg">
              <button type="button" class={identity === 'generate' ? 'active' : ''} onClick={() => setIdentity('generate')}>
                Generate new
              </button>
              <button type="button" class={identity === 'paste' ? 'active' : ''} onClick={() => setIdentity('paste')}>
                Use my nsec
              </button>
            </div>
          </div>
          {identity === 'paste' && (
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">nsec (or 64-char hex)</span>
              <input type="password" autocomplete="off" class="lc-input font-mono text-xs" placeholder="nsec1…"
                value={nsec} onInput={(e) => setNsec((e.target as HTMLInputElement).value)} required />
            </label>
          )}

          <div class="grid md:grid-cols-2 gap-4">
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">Relays (comma-separated)</span>
              <input class="lc-input font-mono text-xs" value={relays}
                onInput={(e) => setRelays((e.target as HTMLInputElement).value)} />
            </label>
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">
                Groups (<span class="font-mono">wss://relay|id</span>, optional)
              </span>
              <input class="lc-input font-mono text-xs" placeholder="wss://public.obelisk.ar|abc123"
                value={groups} onInput={(e) => setGroups((e.target as HTMLInputElement).value)} />
            </label>
          </div>

          {(info.extraEnv ?? []).map((f) => (
            <label key={f.key} class="block">
              <span class="text-xs text-lc-muted block mb-1">{f.label} <span class="font-mono">({f.key})</span></span>
              <input class="lc-input font-mono text-xs"
                placeholder={f.default === '$ADMIN' ? 'empty = you' : f.default ?? ''}
                value={extra[f.key] ?? ''}
                onInput={(e) => setExtra({ ...extra, [f.key]: (e.target as HTMLInputElement).value })} />
            </label>
          ))}

          {info.notes && <p class="text-xs text-yellow-400/90">ℹ {info.notes}</p>}
        </div>

        <div class="flex justify-end gap-2 mt-6">
          <button type="button" class="lc-pill-secondary text-sm" onClick={onClose}>Cancel</button>
          <button class="lc-pill-primary text-sm" disabled={busy || (identity === 'paste' && !nsec.trim())}>
            {busy ? <span class="lc-spinner" /> : 'Turn on'}
          </button>
        </div>
      </form>
    </div>
  )
}
