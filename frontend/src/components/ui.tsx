// Small shared UI helpers.
import { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { NostrProfile } from '../api'

export const shortNpub = (npub: string | null) =>
  npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : '—'

export const fmtUptime = (ms: number | null) => {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export const fmtMem = (bytes: number | null) =>
  bytes == null || bytes === 0 ? '—' : `${(bytes / 1024 / 1024).toFixed(0)} MB`

export const timeAgo = (ts: number) => {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'online' ? 'lc-dot-online' : status === 'errored' ? 'lc-dot-errored' : 'lc-dot-stopped'
  return <span class={`lc-dot ${cls}`} title={status} />
}

export function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      class="font-mono text-xs text-lc-muted hover:text-lc-green transition-colors"
      title={text}
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? '✓ copied' : label}
    </button>
  )
}

export function Section({ title, children, actions }: {
  title: string
  children: ComponentChildren
  actions?: ComponentChildren
}) {
  return (
    <section class="lc-card p-5 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-bold text-lg">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Flash({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  if (!text) return null
  return (
    <div
      class={`rounded-lg px-4 py-2 text-sm mb-4 border ${
        kind === 'ok'
          ? 'bg-lc-olive-dark border-lc-olive text-lc-green'
          : 'bg-red-950 border-red-800 text-red-300'
      }`}
    >
      {text}
    </div>
  )
}

// ── Identity ────────────────────────────────────────────────────────────


/** The relays stopped returning this profile (we only have a cached copy). */
export const profileMissing = (profile: NostrProfile | null | undefined) =>
  !!profile && (!profile.seenAt || Date.now() / 1000 - profile.seenAt > 3600)

export const profileName = (profile: NostrProfile | null | undefined, fallback: string) =>
  profile?.display_name || profile?.name || fallback

/**
 * Nostr avatar: the kind 0 picture when there is one and it loads, else a
 * monogram. `status` adds the fleet status ring + dot.
 */
export function Avatar({ picture, label, size = 44, status, rounded = 'xl' }: {
  picture?: string | null
  label: string
  size?: number
  status?: string
  rounded?: 'xl' | 'full'
}) {
  const [broken, setBroken] = useState(false)
  const initials = label.replace(/^obelisk-/, '').split(/[-_\s]+/).filter(Boolean)
    .map((w) => [...w][0]).join('').slice(0, 2).toUpperCase() || '?'
  const radius = rounded === 'full' ? '9999px' : `${Math.round(size * 0.28)}px`
  const off = status && status !== 'online'
  return (
    <span class="lc-avatar" style={{ width: `${size}px`, height: `${size}px`, borderRadius: radius }}>
      {picture && !broken ? (
        <img src={picture} alt="" loading="lazy" referrerpolicy="no-referrer"
          class={off ? 'grayscale opacity-60' : ''}
          style={{ borderRadius: radius }}
          onError={() => setBroken(true)} />
      ) : (
        <span class={`lc-avatar-mono ${off ? 'lc-monogram-off' : ''}`}
          style={{ borderRadius: radius, fontSize: `${Math.max(11, Math.round(size * 0.36))}px` }}>
          {initials}
        </span>
      )}
      {status && <span class={`lc-avatar-status lc-dot-${status === 'online' ? 'online' : status === 'errored' ? 'errored' : 'stopped'}`} />}
    </span>
  )
}

const iconBase = {
  fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
  'stroke-linejoin': 'round', viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true',
} as const

export const Icon = {
  bots: () => <svg {...iconBase}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></svg>,
  settings: () => <svg {...iconBase}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  operator: () => <svg {...iconBase}><path d="M4 17l6-6-6-6M12 19h8" /></svg>,
  docs: () => <svg {...iconBase}><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h7" /></svg>,
  logout: () => <svg {...iconBase}><path d="M15 17l5-5-5-5M20 12H9M11 21H5a1 1 0 01-1-1V4a1 1 0 011-1h6" /></svg>,
  search: () => <svg {...iconBase} width={16} height={16}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  plus: () => <svg {...iconBase} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>,
  play: () => <svg {...iconBase} width={14} height={14}><path d="M7 5l12 7-12 7z" /></svg>,
  stop: () => <svg {...iconBase} width={14} height={14}><rect x="6" y="6" width="12" height="12" rx="1" /></svg>,
  restart: () => <svg {...iconBase} width={14} height={14}><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" /></svg>,
  bolt: () => <svg {...iconBase} width={14} height={14}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>,
  menu: () => <svg {...iconBase}><path d="M4 7h16M4 12h16M4 17h16" /></svg>,
}
