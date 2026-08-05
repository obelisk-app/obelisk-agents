// Minimal global toast bus: call toast.ok()/toast.err() from anywhere,
// render <Toasts/> once at the root.
import { useEffect, useState } from 'preact/hooks'

interface Toast {
  id: number
  kind: 'ok' | 'err'
  text: string
}

let seq = 0
let listener: ((t: Toast) => void) | null = null

export const toast = {
  ok: (text: string) => listener?.({ id: ++seq, kind: 'ok', text }),
  err: (text: string) => listener?.({ id: ++seq, kind: 'err', text }),
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([])

  useEffect(() => {
    listener = (t) => {
      setItems((prev) => [...prev.slice(-3), t])
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 5000)
    }
    return () => { listener = null }
  }, [])

  return (
    <div class="fixed top-16 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          class={`lc-toast ${t.kind === 'ok' ? 'lc-toast-ok' : 'lc-toast-err'}`}
          onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
        >
          <span class="font-semibold mr-1">{t.kind === 'ok' ? '✓' : '✕'}</span>
          {t.text}
        </div>
      ))}
    </div>
  )
}
