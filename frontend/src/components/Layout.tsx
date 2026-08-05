import { ComponentChildren } from 'preact'
import { api } from '../api'
import { shortNpub } from './ui'

const NAV = [
  { href: '/', label: 'Bots' },
  { href: '/settings', label: 'Settings' },
  { href: '/operator', label: 'Operator' },
  { href: '/docs', label: 'Docs' },
]

export function Layout({ npub, path, onLogout, children }: {
  npub: string
  path: string
  onLogout: () => void
  children: ComponentChildren
}) {
  return (
    <div class="min-h-screen lc-grid-bg">
      <header class="border-b border-lc-border bg-lc-black/80 backdrop-blur sticky top-0 z-20">
        <div class="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <a href="/" class="font-extrabold whitespace-nowrap">
            ⛩ Obelisk <span class="text-lc-green">Agents</span>
          </a>
          <nav class="flex gap-1 flex-1">
            {NAV.map((item) => (
              <a
                href={item.href}
                class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  (item.href === '/' ? path === '/' : path.startsWith(item.href))
                    ? 'bg-lc-olive-dark text-lc-green'
                    : 'text-lc-muted hover:text-lc-white'
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <span class="font-mono text-xs text-lc-muted hidden sm:block" title={npub}>
            {shortNpub(npub)}
          </span>
          <button
            class="text-xs text-lc-muted hover:text-lc-white transition-colors"
            onClick={() => api.logout().then(onLogout)}
          >
            Logout
          </button>
        </div>
      </header>
      <main class="max-w-6xl mx-auto px-4 py-8">{children}</main>
      <footer class="max-w-6xl mx-auto px-4 pb-8 text-xs text-lc-muted/60">
        bots.obelisk.ar · part of the{' '}
        <a class="hover:text-lc-green" href="https://github.com/obelisk-app" target="_blank" rel="noreferrer">
          Obelisk family
        </a>
      </footer>
    </div>
  )
}
