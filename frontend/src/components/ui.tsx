// Small shared UI helpers.
import { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'

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
