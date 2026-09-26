// Mobile nicety ported from obelisk-relay: while the nostrconnect QR is on
// screen, inject an "Open in signer app" link carrying the same URI, so a
// phone user can hand off to Amber / Primal without a second device.
// Watches document.body (not the first widget root it sees) because the
// login modal mounts and unmounts its portal every time it opens.
import { useEffect } from 'preact/hooks'

export function Nip46SignerDeepLink() {
  useEffect(() => {
    let injected: HTMLAnchorElement | null = null

    const removeInjected = () => {
      if (injected?.isConnected) injected.remove()
      injected = null
    }

    const sync = () => {
      const qrWrap = document.querySelector<HTMLElement>('.nui-qr-wrap')
      const uri = qrWrap?.querySelector<HTMLElement>('.nui-key-display')?.textContent?.trim()
      if (!qrWrap || !uri || !uri.startsWith('nostrconnect://')) {
        removeInjected()
        return
      }
      if (injected?.isConnected && injected.getAttribute('href') === uri) return

      removeInjected()
      const link = document.createElement('a')
      link.href = uri
      link.className = 'nui-open-signer'
      link.rel = 'noopener noreferrer'
      link.textContent = 'Open in signer app →'
      qrWrap.insertBefore(link, qrWrap.firstChild)
      injected = link
    }

    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    sync()
    return () => {
      observer.disconnect()
      removeInjected()
    }
  }, [])

  return null
}
