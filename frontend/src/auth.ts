// Admin login: sign a kind 22242 challenge event (same shape as
// obelisk-relay's admin panel) with a NIP-07 extension, or with a pasted
// nsec that never leaves the browser.
import { finalizeEvent, nip19 } from 'nostr-tools'
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

export async function loginWithExtension() {
  if (!window.nostr) throw new Error('No NIP-07 extension found (install Alby, nos2x, …)')
  const { challenge } = await api.challenge()
  const unsigned = { ...template(challenge), pubkey: await window.nostr.getPublicKey() }
  const event = await window.nostr.signEvent(unsigned)
  await api.login(event)
}

export async function loginWithNsec(nsec: string) {
  const decoded = nip19.decode(nsec.trim())
  if (decoded.type !== 'nsec') throw new Error('that is not an nsec')
  const { challenge } = await api.challenge()
  const event = finalizeEvent(template(challenge), decoded.data)
  await api.login(event)
}
