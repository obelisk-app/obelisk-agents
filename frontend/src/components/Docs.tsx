import { useEffect, useState } from 'preact/hooks'
import { marked } from 'marked'
import { api } from '../api'
import { Flash } from './ui'

export function Docs({ file }: { file?: string; path?: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [current, setCurrent] = useState(file ? decodeURIComponent(file) : 'README.md')
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    api.docs().then(setFiles).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    setError('')
    api.doc(encodeURIComponent(current))
      .then(async (md) => setHtml(await marked.parse(md)))
      .catch((e) => setError(e.message))
  }, [current])

  return (
    <div class="animate-fade-in-up flex gap-6 items-start flex-col md:flex-row">
      <nav class="lc-card p-3 md:w-56 w-full md:sticky md:top-20 shrink-0">
        {files.map((f) => (
          <button
            key={f}
            class={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
              f === current ? 'bg-lc-olive-dark text-lc-green' : 'text-lc-muted hover:text-lc-white'
            }`}
            onClick={() => setCurrent(f)}
          >
            {f.replace(/^docs\//, '').replace(/\.md$/, '')}
          </button>
        ))}
      </nav>
      <article class="lc-card p-6 flex-1 min-w-0">
        <Flash kind="err" text={error} />
        <div class="lc-md" dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
  )
}
