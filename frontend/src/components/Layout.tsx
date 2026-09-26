// App shell: sidebar navigation (top bar + drawer on small screens) with
// the signed-in admin's Nostr identity at the bottom.
import { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useLogout, useSigner } from '@nostr-wot/ui'
import type { NostrSigner } from '@nostr-wot/signers'
import { api, Session } from '../api'
import { clearStoredSigners } from '../auth'
import { Avatar, Icon, profileName, shortNpub } from './ui'

const NAV = [
  { href: '/', label: 'Fleet', icon: Icon.bots },
  { href: '/operator', label: 'Operator', icon: Icon.operator },
  { href: '/settings', label: 'Settings', icon: Icon.settings },
  { href: '/docs', label: 'Docs', icon: Icon.docs },
]

export function Layout({ session, path, onLogout, children }: {
  session: Session
  path: string
  onLogout: () => void
  children: ComponentChildren
}) {
  const [drawer, setDrawer] = useState(false)
  const signer = useSigner() as NostrSigner | null
  const sdkLogout = useLogout()

  useEffect(() => setDrawer(false), [path])

  // Server session, persisted signer and SDK session all go — otherwise a
  // reload would sign straight back in with the saved signer.
  const logout = async () => {
    await api.logout().catch(() => {})
    await clearStoredSigners(signer)
    await sdkLogout().catch(() => {})
    onLogout()
  }

  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/bots') : path.startsWith(href))
  const name = profileName(session.profile, 'Admin')

  const nav = (
    <nav class="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: I }) => (
        <a key={href} href={href} class={`lc-nav-item ${active(href) ? 'active' : ''}`}>
          <I /> {label}
        </a>
      ))}
    </nav>
  )

  const identity = (
    <div class="lc-identity">
      <Avatar picture={session.profile?.picture} label={name} size={36} rounded="full" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold truncate">{name}</div>
        <div class="text-[11px] text-lc-muted font-mono truncate" title={session.npub}>
          {session.profile?.nip05 ?? shortNpub(session.npub ?? null)}
        </div>
      </div>
      <button class="lc-icon-btn" title="Sign out" onClick={logout}><Icon.logout /></button>
    </div>
  )

  const brand = (
    <a href="/" class="flex items-center gap-2.5 font-extrabold text-lg">
      <span class="lc-brand-mark !w-8 !h-8 !text-base !rounded-lg">⛩</span>
      <span>Obelisk <span class="text-lc-green">Agents</span></span>
    </a>
  )

  return (
    <div class="min-h-screen lc-grid-bg lg:pl-64">
      {/* Desktop sidebar */}
      <aside class="lc-sidebar hidden lg:flex">
        <div class="px-2 mb-8">{brand}</div>
        {nav}
        <div class="mt-auto space-y-3">
          <p class="px-3 text-[11px] text-lc-muted/60 leading-relaxed">
            agents.obelisk.ar · part of the{' '}
            <a class="hover:text-lc-green" href="https://github.com/obelisk-app" target="_blank" rel="noreferrer">Obelisk family</a>
          </p>
          {identity}
        </div>
      </aside>

      {/* Mobile top bar + drawer */}
      <header class="lg:hidden sticky top-0 z-30 border-b border-lc-border bg-lc-black/85 backdrop-blur">
        <div class="h-14 px-4 flex items-center justify-between">
          {brand}
          <div class="flex items-center gap-2">
            <Avatar picture={session.profile?.picture} label={name} size={30} rounded="full" />
            <button class="lc-icon-btn" aria-label="Menu" onClick={() => setDrawer(!drawer)}><Icon.menu /></button>
          </div>
        </div>
        {drawer && (
          <div class="px-4 pb-4 space-y-4 animate-fade-in-up">
            {nav}
            {identity}
          </div>
        )}
      </header>

      <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 py-8">{children}</main>
    </div>
  )
}
