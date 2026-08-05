// Admin login: sign a kind 22242 challenge event (same shape as
// obelisk-relay's admin panel) with a NIP-07 extension, a NIP-46 remote
// signer (bunker:// / NIP-05 / nostrconnect QR), or a pasted nsec that
// never leaves the browser.
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'nostr-tools/nip46'
import { api } from './api'

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(event: object): Promise<object>
}

declare global {
  interface Window {
    nostr?: Nip07
  }
}

const template = (challenge: string) => ({
  kind: 22242,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['relay', window.location.origin.replace(/^http/, 'ws')],
    ['challenge', challenge],
  ],
  content: '',
})

const withTimeout = <T,>(p: Promise<T>, message: string, ms = 30000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])

async function signChallengeAndLogin(sign: (evt: ReturnType<typeof template>) => Promise<object>) {
  const { challenge } = await api.challenge()
  const event = await sign(template(challenge))
  await api.login(event)
}

export async function loginWithExtension() {
  if (!window.nostr) throw new Error('No NIP-07 extension found (install Alby, nos2x, …)')
  await signChallengeAndLogin(async (evt) => {
    const unsigned = { ...evt, pubkey: await window.nostr!.getPublicKey() }
    return window.nostr!.signEvent(unsigned)
  })
}

export async function loginWithNsec(nsec: string) {
  const decoded = nip19.decode(nsec.trim())
  if (decoded.type !== 'nsec') throw new Error('that is not an nsec')
  await signChallengeAndLogin(async (evt) => finalizeEvent(evt, decoded.data))
}

// ── NIP-46 remote signing ───────────────────────────────────────────────

// bunker://… URI or user@domain NIP-05. `onAuthUrl` fires if the signer
// wants the user to approve in its own web UI.
export async function loginWithBunker(input: string, onAuthUrl?: (url: string) => void) {
  const bp = await parseBunkerInput(input.trim())
  if (!bp) throw new Error('not a valid bunker:// URI or NIP-05 identifier')
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, {
    onauth: (url) => onAuthUrl?.(url),
  })
  try {
    await withTimeout(signer.connect(), 'remote signer did not answer the connect request')
    await signChallengeAndLogin((evt) =>
      withTimeout(signer.signEvent(evt), 'remote signer did not sign (approve the request in your signer app)'))
  } finally {
    signer.close().catch(() => {})
  }
}

// nostrconnect:// flow: we mint a URI, the signer app scans/receives it
// and connects back to us over the relays.
const NOSTRCONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.primal.net']

export interface NostrConnectFlow {
  uri: string
  /** resolves once the signer connected and signed us in */
  done: Promise<void>
  cancel: () => void
}

export function startNostrConnect(): NostrConnectFlow {
  const clientSk = generateSecretKey()
  const secret = Math.random().toString(36).slice(2, 12)
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSk),
    relays: NOSTRCONNECT_RELAYS,
    secret,
    name: 'Obelisk Agents',
    url: window.location.origin,
  })
  const abort = new AbortController()
  const done = (async () => {
    const signer = await BunkerSigner.fromURI(clientSk, uri, {}, abort.signal)
    try {
      await signChallengeAndLogin((evt) =>
        withTimeout(signer.signEvent(evt), 'remote signer did not sign (approve the request in your signer app)'))
    } finally {
      signer.close().catch(() => {})
    }
  })()
  return { uri, done, cancel: () => abort.abort() }
}
