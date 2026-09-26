// Sign-in screen: a branded splash plus @nostr-wot/ui's LoginModal (the
// same sign-in obelisk-dex and the relay admin use). The modal only
// attaches a signer; `authenticate` then signs our kind 22242 challenge
// with it and the server decides whether that pubkey is an admin.
//
// Flow details ported from obelisk-relay's AdminAuth:
//   • a signer the SDK restored on load (extension, saved bunker, saved
//     nsec) signs in automatically — no clicks on a reload;
//   • after an explicit logout / "use another signer" nothing signs in
//     until the user picks again (an extension is always present, so the
//     SDK would otherwise hand back the key we were asked to drop);
//   • a stored NIP-46 session whose bunker is gone is discarded instead
//     of failing identically on every load.
import { useEffect, useRef, useState } from 'preact/hooks'
import { LoginModal, useLogout, useSigner } from '@nostr-wot/ui'
import type { NostrSigner } from '@nostr-wot/signers'
import { NIP46_RELAYS, authenticate, clearStoredSigners, isDeadSignerError, withTimeout } from '../auth'
import { LOGIN_METHOD_ICONS } from './loginIcons'
import { Nip46SignerDeepLink } from './Nip46SignerDeepLink'
import { Icon } from './ui'

export function Login({ onLogin, fresh = false }: { onLogin: () => void; fresh?: boolean }) {
  const signer = useSigner() as NostrSigner | null
  const logout = useLogout()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [signerPubkey, setSignerPubkey] = useState<string | null>(null)
  const [awaitingChoice, setAwaitingChoice] = useState(fresh)
  const attempted = useRef<string | null>(null)
  const widgetBusy = useRef(false)

  const discardDeadSigner = async (dead: NostrSigner | null) => {
    await clearStoredSigners(dead)
    attempted.current = null
    setAwaitingChoice(true)
    setError('Your saved signer connection expired. Sign in again.')
    await logout()
    setOpen(true)
  }

  const run = async (active: NostrSigner) => {
    setBusy(true)
    setError('')
    try {
      await authenticate(active)
      onLogin()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Authentication failed'
      setError(message)
      throw new Error(message)
    } finally {
      setBusy(false)
    }
  }

  // A signer the SDK restored on load signs in on its own.
  useEffect(() => {
    if (!signer || awaitingChoice || widgetBusy.current) return
    let cancelled = false
    void (async () => {
      try {
        const pubkey = await withTimeout(signer.getPublicKey(),
          'Your saved signer did not respond. Use another signer.', 15_000)
        if (cancelled || attempted.current === pubkey) return
        attempted.current = pubkey
        setSignerPubkey(pubkey)
        setOpen(false)
        await run(signer)
      } catch (e) {
        if (cancelled) return
        if (isDeadSignerError(e)) await discardDeadSigner(signer)
        else setError(e instanceof Error ? e.message : 'Signer is unavailable')
      }
    })()
    return () => { cancelled = true }
  }, [signer, awaitingChoice])

  // Nothing restored after a beat → open the modal so the first screen is
  // the actual sign-in, not a button that leads to it.
  useEffect(() => {
    const t = setTimeout(() => { if (!signer || awaitingChoice) setOpen(true) }, 450)
    return () => clearTimeout(t)
  }, [])

  const onWidgetLogin = async ({ signer: picked }: { signer: NostrSigner }) => {
    widgetBusy.current = true
    setAwaitingChoice(false)
    try {
      const pubkey = await withTimeout(picked.getPublicKey(), 'Signer did not respond.')
      attempted.current = pubkey
      setSignerPubkey(pubkey)
      await run(picked)
    } catch (e) {
      if (isDeadSignerError(e)) {
        await discardDeadSigner(picked)
        return
      }
      throw e // keeps the modal open with the message inline
    } finally {
      widgetBusy.current = false
    }
  }

  const useAnother = async () => {
    setAwaitingChoice(true)
    setError('')
    setBusy(false)
    setSignerPubkey(null)
    attempted.current = null
    await clearStoredSigners(signer)
    await logout()
    setOpen(true)
  }

  const authenticating = busy || (!!signer && !awaitingChoice && !error)

  return (
    <div class="min-h-screen lc-grid-bg relative overflow-hidden flex items-center justify-center px-4 py-10">
      <Nip46SignerDeepLink />
      <div class="lc-orb" style="top:-10%;left:-10%" />
      <div class="lc-orb lc-orb-2" style="bottom:-20%;right:-10%" />

      <div class="relative w-full max-w-5xl grid lg:grid-cols-[1.1fr_1fr] gap-10 items-center">
        <div class="animate-fade-in-up hidden lg:block">
          <div class="lc-brand-mark mb-6">⛩</div>
          <h1 class="text-5xl font-extrabold tracking-tight leading-[1.05]">
            Obelisk <span class="text-lc-green lc-glow-text">Agents</span>
          </h1>
          <p class="text-lc-muted text-lg mt-4 max-w-md">
            The control plane for the Obelisk bot fleet — supervise, configure and build Nostr
            bots and LLM agents across our NIP-29 relays.
          </p>
          <ul class="mt-8 space-y-3 text-sm">
            {[
              ['Live fleet', 'PM2 status, logs and restarts for every bot'],
              ['Nostr-native', 'each bot has its own key, profile and avatar'],
              ['Operator', 'describe a bot, Codex builds and ships it'],
            ].map(([title, text]) => (
              <li key={title} class="flex items-start gap-3">
                <span class="lc-check">✓</span>
                <span><span class="font-semibold text-lc-white">{title}</span>
                  <span class="text-lc-muted"> — {text}</span></span>
              </li>
            ))}
          </ul>
        </div>

        <div class="lc-card lc-glow p-8 w-full max-w-md mx-auto animate-fade-in-up">
          <div class="lg:hidden text-center mb-6">
            <div class="lc-brand-mark mx-auto mb-3">⛩</div>
            <h1 class="text-2xl font-extrabold">Obelisk <span class="text-lc-green">Agents</span></h1>
          </div>
          <h2 class="text-xl font-bold">Admin sign-in</h2>
          <p class="text-sm text-lc-muted mt-1 mb-6">
            Sign a one-time challenge with your Nostr identity. Only fleet admins get in; your key
            never leaves your signer.
          </p>

          {error && (
            <div class="mb-4 rounded-lg px-4 py-3 text-sm bg-red-500/10 text-red-300 border border-red-500/20">
              {error}
            </div>
          )}

          {authenticating ? (
            <div class="space-y-3">
              <div class="flex items-center gap-3 rounded-xl border border-lc-border bg-lc-black px-4 py-3">
                <span class="lc-spinner !w-4 !h-4" />
                <span class="text-sm">
                  {busy ? 'Waiting for your signature…' : 'Preparing your signer…'}
                  {signerPubkey && <span class="block text-xs text-lc-muted font-mono mt-0.5">{signerPubkey.slice(0, 16)}…</span>}
                </span>
              </div>
              <button class="lc-pill-secondary w-full" onClick={useAnother}>Use another signer</button>
            </div>
          ) : (
            <div class="space-y-3">
              <button class="lc-pill-primary w-full !py-3 text-base gap-2" onClick={() => setOpen(true)}>
                <Icon.bolt /> Sign in with Nostr
              </button>
              <p class="text-xs text-lc-muted text-center">
                Extension (Alby, nos2x…) · Remote signer (Amber, nsec.app, Primal) · nsec
              </p>
            </div>
          )}
        </div>
      </div>

      <div class="obelisk-login">
        <LoginModal
          open={open}
          onClose={() => setOpen(false)}
          title="Sign in to Obelisk Agents"
          subtitle="Use the Nostr key authorized as a fleet admin."
          methods={['nip07', 'nip46', 'import']}
          methodIcons={LOGIN_METHOD_ICONS}
          flatLayout
          nip46Mode="qr"
          nip46Relays={NIP46_RELAYS}
          nip46Metadata={{
            name: 'Obelisk Agents',
            url: window.location.origin,
            description: 'Admin sign-in for the Obelisk bot fleet',
          }}
          onLogin={onWidgetLogin}
          onError={setError}
        />
      </div>
    </div>
  )
}
