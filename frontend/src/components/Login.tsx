import { useEffect, useRef, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import { loginWithBunker, loginWithExtension, loginWithNsec, startNostrConnect, NostrConnectFlow } from '../auth'
import { Flash } from './ui'

type Method = 'extension' | 'remote' | 'nsec'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [method, setMethod] = useState<Method>('extension')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onLogin()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="min-h-screen lc-grid-bg flex items-center justify-center px-4 relative overflow-hidden">
      {/* ambient glow */}
      <div class="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style="background: radial-gradient(circle, rgba(180,249,83,0.07) 0%, transparent 65%); top: 15%; left: 50%; transform: translateX(-50%);" />

      <div class="lc-card lc-glow p-8 w-full max-w-md animate-fade-in-up relative">
        <div class="text-center mb-6">
          <div class="lc-monogram mx-auto mb-4 !w-14 !h-14 !rounded-2xl text-xl">⛩</div>
          <h1 class="text-2xl font-extrabold lc-glow-text">
            Obelisk <span class="text-lc-green">Agents</span>
          </h1>
          <p class="text-lc-muted text-sm mt-2">
            Fleet control panel. Admins sign a challenge with their Nostr key — nothing else gets in.
          </p>
        </div>

        <div class="lc-seg mb-5">
          <button class={method === 'extension' ? 'active' : ''} onClick={() => setMethod('extension')}>Extension</button>
          <button class={method === 'remote' ? 'active' : ''} onClick={() => setMethod('remote')}>Remote signer</button>
          <button class={method === 'nsec' ? 'active' : ''} onClick={() => setMethod('nsec')}>nsec</button>
        </div>

        <Flash kind="err" text={error} />

        {method === 'extension' && (
          <ExtensionPane busy={busy} onGo={() => attempt(loginWithExtension)} />
        )}
        {method === 'remote' && (
          <RemotePane busy={busy} attempt={attempt} onLogin={onLogin} onError={setError} />
        )}
        {method === 'nsec' && <NsecPane busy={busy} attempt={attempt} />}
      </div>
    </div>
  )
}

function ExtensionPane({ busy, onGo }: { busy: boolean; onGo: () => void }) {
  return (
    <div>
      <button class="lc-pill-primary w-full" disabled={busy} onClick={onGo}>
        {busy ? <span class="lc-spinner" /> : 'Sign in with browser extension'}
      </button>
      <p class="text-xs text-lc-muted mt-3 text-center">
        Uses NIP-07 — Alby, nos2x, Flamingo, horse…
      </p>
    </div>
  )
}

// NIP-46: paste a bunker:// URI / NIP-05, or scan a nostrconnect QR from
// a mobile signer (Amber, nsec.app, Alby Hub).
function RemotePane({ busy, attempt, onLogin, onError }: {
  busy: boolean
  attempt: (fn: () => Promise<void>) => Promise<void>
  onLogin: () => void
  onError: (e: string) => void
}) {
  const [bunker, setBunker] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [qr, setQr] = useState('')
  const flowRef = useRef<NostrConnectFlow | null>(null)
  const [waitingQr, setWaitingQr] = useState(false)

  useEffect(() => () => flowRef.current?.cancel(), [])

  const showQr = async () => {
    onError('')
    const flow = startNostrConnect()
    flowRef.current = flow
    setWaitingQr(true)
    setQr(await QRCode.toDataURL(flow.uri, {
      width: 232,
      margin: 1,
      color: { dark: '#0a0a0a', light: '#fafafa' },
    }))
    try {
      await flow.done
      onLogin()
    } catch (e) {
      if (!String(e).includes('abort')) onError((e as Error).message || 'nostrconnect flow failed')
      setWaitingQr(false)
      setQr('')
    }
  }

  return (
    <div class="space-y-4">
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          attempt(() => loginWithBunker(bunker, (url) => setAuthUrl(url)))
        }}
      >
        <input
          class="lc-input font-mono text-xs"
          placeholder="bunker://…  or  name@nsec.app"
          value={bunker}
          onInput={(e) => setBunker((e.target as HTMLInputElement).value)}
        />
        <button class="lc-pill-primary text-sm whitespace-nowrap" disabled={busy || !bunker.trim()}>
          {busy ? <span class="lc-spinner" /> : 'Connect'}
        </button>
      </form>

      {authUrl && (
        <p class="text-xs text-lc-muted">
          Your signer wants confirmation:{' '}
          <a class="text-lc-green hover:underline" href={authUrl} target="_blank" rel="noreferrer">open auth page ↗</a>
        </p>
      )}

      <div class="flex items-center gap-3 text-xs text-lc-muted">
        <span class="flex-1 border-t border-lc-border" /> or scan from your phone <span class="flex-1 border-t border-lc-border" />
      </div>

      {!qr ? (
        <button class="lc-pill-secondary w-full text-sm" onClick={showQr} disabled={waitingQr}>
          Show nostrconnect QR
        </button>
      ) : (
        <div class="text-center">
          <img src={qr} alt="nostrconnect QR" class="mx-auto rounded-lg" />
          <div class="flex items-center justify-center gap-2 mt-3 text-xs text-lc-muted">
            <span class="lc-spinner !w-3.5 !h-3.5" /> waiting for your signer…
            <button
              class="text-lc-green hover:underline"
              onClick={() => navigator.clipboard.writeText(flowRef.current?.uri ?? '')}
            >
              copy URI
            </button>
            <button
              class="text-red-400 hover:underline"
              onClick={() => { flowRef.current?.cancel(); setQr(''); setWaitingQr(false) }}
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function NsecPane({ busy, attempt }: {
  busy: boolean
  attempt: (fn: () => Promise<void>) => Promise<void>
}) {
  const [nsec, setNsec] = useState('')
  return (
    <div>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          attempt(() => loginWithNsec(nsec))
        }}
      >
        <input
          class="lc-input font-mono"
          type="password"
          placeholder="nsec1…"
          value={nsec}
          onInput={(e) => setNsec((e.target as HTMLInputElement).value)}
        />
        <button class="lc-pill-primary" disabled={busy || !nsec.trim()}>
          {busy ? <span class="lc-spinner" /> : 'Go'}
        </button>
      </form>
      <p class="text-xs text-lc-muted mt-3 text-center">
        Signs locally in this tab — the key is never sent or stored.
      </p>
    </div>
  )
}
