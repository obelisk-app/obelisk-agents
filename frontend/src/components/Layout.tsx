// App shell: sidebar navigation (top bar + drawer on small screens) with
// the signed-in admin's Nostr identity at the bottom.
import { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useLogout, useSigner } from '@nostr-wot/ui'
import type { NostrSigner } from '@nostr-wot/signers'
import { api, Session } from '../api'
import { clearStoredSigners } from '../auth'
import { Avatar, CopyChip, Icon, profileName, shortNpub } from './ui'
import { Logo } from './Logo'
import { openNewBotWizard } from './Dashboard'

// `description` is the terse line under the sidebar entry; `blurb` is the
// fuller sentence in the page header. Both live here so each section is
// described in one place, and the pages no longer repeat their own title.
const NAV = [
  { href: '/', label: 'Fleet', description: 'Your bots', icon: Icon.bots,
    blurb: 'Every bot runs with its own Nostr identity — this is how they look to the world.' },
  { href: '/operator', label: 'Operator', description: 'AI agent with repo access', icon: Icon.operator,
    blurb: 'Ask an AI agent to build a new bot, tweak one, or investigate a problem.' },
  { href: '/settings', label: 'Settings', description: 'Fleet-wide defaults', icon: Icon.settings,
    blurb: "Fleet-wide defaults — changes save automatically. Each bot's own page can override any of this for itself." },
  { href: '/docs', label: 'Docs', description: 'Guides and reference', icon: Icon.docs,
    blurb: 'How the fleet works, and how to build and run bots on it.' },
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
    <nav class="flex flex-col gap-2">
      {NAV.map(({ href, label, description, icon: I }) => (
        <a key={href} href={href} class={`lc-nav-item ${active(href) ? 'active' : ''}`}>
          <I />
          <span class="min-w-0">
            <span class="lc-nav-label">{label}</span>
            <span class="lc-nav-desc">{description}</span>
          </span>
        </a>
      ))}
      <button class="lc-pill-primary w-full justify-center gap-2 !py-3 text-base font-bold mt-2" onClick={() => { setDrawer(false); openNewBotWizard() }}>
        <Icon.plus /> New bot
      </button>
    </nav>
  )

  const identity = (
    <div class="lc-identity">
      <Avatar picture={session.profile?.picture} label={name} size={36} rounded="full" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold truncate">{name}</div>
        <div class="text-[11px] text-lc-muted font-mono truncate" title={session.npub}>
          {session.npub
            ? <CopyChip text={session.npub} label={session.profile?.nip05 ?? shortNpub(session.npub)} />
            : session.profile?.nip05}
        </div>
      </div>
      <button class="lc-icon-btn" title="Sign out" onClick={logout}><Icon.logout /></button>
    </div>
  )

  const brand = (
    <a href="/" class="flex items-center gap-2.5 font-extrabold text-lg">
      <Logo size={32} />
      <span>Obelisk <span class="text-lc-green">Agents</span></span>
    </a>
  )

  const section = NAV.find(({ href }) => active(href)) ?? NAV[0]!

  // Desktop is a fixed-height column: header banner, then the only region
  // that scrolls. The banner sits outside the scroll region, so the section
  // title stays at the top however far the page scrolls. On mobile the page
  // scrolls as a whole under the sticky brand header.
  return (
    <div class="min-h-screen lg:h-screen lg:overflow-hidden lg:pl-72 flex flex-col">
      {/* Desktop sidebar */}
      <aside class="lc-sidebar hidden lg:flex">
        <div class="admin-header-bar px-5">{brand}</div>
        <div class="p-3 flex-1 min-h-0 overflow-y-auto">{nav}</div>
        <div class="p-4 space-y-3 border-t border-lc-border">
          <p class="px-1 text-[11px] text-lc-muted/60 leading-relaxed">
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

      <div class="admin-header-bar flex-shrink-0 px-4 sm:px-6 lg:px-10">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold">{section.label}</h1>
          <p class="admin-header-blurb">{section.blurb}</p>
        </div>
      </div>

      <main class="flex-1 min-h-0 lg:overflow-y-auto lc-grid-bg">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 py-8">{children}</div>
      </main>
    </div>
  )
}
