// Admin login plumbing on top of @nostr-wot/signers + @nostr-wot/ui.
//
// The manager authenticates exactly like obelisk-relay's admin panel: fetch
// a challenge, sign a kind 22242 event over it with whatever signer the
// user picked in the login modal (NIP-07 extension, NIP-46 bunker / QR,
// or an imported nsec that never leaves the browser), post it back, get a
// session cookie. Everything signer-related (persistence, restore, the
// QR pairing) is the SDK's job; this file only covers what's specific to
// us — the challenge event and recovering from dead NIP-46 sessions.
import { SIGNER_STORAGE_KEY_NIP46, clearPersistedNip46, clearPersistedNsec } from '@nostr-wot/ui'
import type { NostrSigner } from '@nostr-wot/signers'
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { nip19 } from 'nostr-tools'
import { api } from './api'

const SIGNER_TIMEOUT_MS = 30_000

// Rendezvous relays for NIP-46: public.obelisk.ar first (both ends can
// reach it — same choice as obelisk-dex and the relay admin), then big
// public relays as fallbacks for signers that won't talk to it.
export const NIP46_RELAYS = [
  'wss://public.obelisk.ar',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

export const withTimeout = async <T,>(op: Promise<T>, message: string, ms = SIGNER_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      op,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function signChallenge(signer: NostrSigner, challenge: string) {
  const pubkey = await signer.getPublicKey()
  return signer.signEvent({
    kind: 22242,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', window.location.origin.replace(/^http/, 'ws')],
      ['challenge', challenge],
    ],
    content: '',
  } as Parameters<NostrSigner['signEvent']>[0])
}

/** One signature → one manager session. */
export async function authenticate(signer: NostrSigner) {
  const { challenge } = await api.challenge()
  let event
  try {
    event = await withTimeout(signChallenge(signer, challenge),
      'Your signer did not respond — approve the request in your Nostr app, or use another signer.')
  } catch (err) {
    // A closed NIP-46 connection can't be revived, but the stored pairing
    // can build a fresh one with the same client key. Retry once.
    if (!isDeadSignerError(err)) throw err
    const rebuilt = await restoreNip46Signer()
    if (!rebuilt) throw err
    event = await withTimeout(signChallenge(rebuilt, challenge),
      'Your signer did not respond — approve the request in your Nostr app, or use another signer.')
  }
  await api.login(event)
}

/** nostr-tools' error when a BunkerSigner's relay subscription is gone. */
export const isDeadSignerError = (e: unknown) =>
  /not open anymore|signer is closed|no longer open/i.test(e instanceof Error ? e.message : String(e ?? ''))

interface StoredNip46 {
  kind?: 'bunker' | 'nostrconnect'
  uri?: string
  bunkerPubkey?: string
  relays?: string[]
  clientNsec?: string
}

/** Rebuild the persisted NIP-46 pairing without replaying `connect`. */
export async function restoreNip46Signer(): Promise<NostrSigner | null> {
  let stored: StoredNip46 | null = null
  try { stored = JSON.parse(localStorage.getItem(SIGNER_STORAGE_KEY_NIP46) ?? 'null') } catch { return null }
  if (!stored?.clientNsec) return null
  let clientSecret: Uint8Array
  try {
    const decoded = nip19.decode(stored.clientNsec)
    if (decoded.type !== 'nsec') return null
    clientSecret = decoded.data
  } catch { return null }

  const bp = stored.kind === 'bunker' && stored.uri
    ? await parseBunkerInput(stored.uri)
    : stored.bunkerPubkey && stored.relays?.length
      ? { pubkey: stored.bunkerPubkey, relays: stored.relays, secret: null }
      : null
  if (!bp?.pubkey || !bp.relays.length) return null

  const signer = BunkerSigner.fromBunker(clientSecret, bp, {
    onauth: (url) => window.open(url, '_blank', 'width=600,height=700'),
  })
  if (bp.secret) await signer.connect()
  else await signer.getPublicKey()
  return signer as unknown as NostrSigner
}

/** Forget every persisted signer (used on logout / "use another signer"). */
export async function clearStoredSigners(signer?: NostrSigner | null) {
  try { await signer?.close?.() } catch { /* already closed */ }
  await clearPersistedNip46()
  await clearPersistedNsec()
}
