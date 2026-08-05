import { useState } from 'preact/hooks'
import { loginWithExtension, loginWithNsec } from '../auth'
import { Flash } from './ui'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showNsec, setShowNsec] = useState(false)
  const [nsec, setNsec] = useState('')

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
    <div class="min-h-screen lc-grid-bg flex items-center justify-center px-4">
      <div class="lc-card lc-glow p-8 w-full max-w-md animate-fade-in-up">
        <div class="text-center mb-8">
          <div class="text-4xl mb-3">🤖</div>
          <h1 class="text-2xl font-extrabold lc-glow-text">
            Obelisk <span class="text-lc-green">Bots</span>
          </h1>
          <p class="text-lc-muted text-sm mt-2">
            Fleet manager for the Obelisk Nostr bots. Admin access only —
            sign in with your Nostr key.
          </p>
        </div>

        <Flash kind="err" text={error} />

        <button
          class="lc-pill-primary w-full mb-3"
          disabled={busy}
          onClick={() => attempt(loginWithExtension)}
        >
          {busy ? <span class="lc-spinner" /> : 'Sign in with extension (NIP-07)'}
        </button>

        {!showNsec ? (
          <button
            class="w-full text-center text-xs text-lc-muted hover:text-lc-white transition-colors py-2"
            onClick={() => setShowNsec(true)}
          >
            or paste an nsec (stays in this tab)
          </button>
        ) : (
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
            <button class="lc-pill-secondary" disabled={busy || !nsec.trim()}>
              Go
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
