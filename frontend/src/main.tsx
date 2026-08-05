import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import Router from 'preact-router'
import './style.css'
import { api } from './api'
import { Login } from './components/Login'
import { Layout } from './components/Layout'
import { Toasts } from './components/toast'
import { Dashboard } from './components/Dashboard'
import { BotDetail } from './components/BotDetail'
import { Settings } from './components/Settings'
import { Operator } from './components/Operator'
import { Docs } from './components/Docs'

function App() {
  const [session, setSession] = useState<{ authed: boolean; npub?: string } | null>(null)
  const [path, setPath] = useState(window.location.pathname)

  const check = () => api.session().then(setSession).catch(() => setSession({ authed: false }))
  useEffect(() => { check() }, [])

  if (session === null) {
    return (
      <div class="min-h-screen flex items-center justify-center">
        <span class="lc-spinner" />
      </div>
    )
  }

  if (!session.authed) return <Login onLogin={check} />

  return (
    <>
      <Toasts />
      <Layout npub={session.npub!} path={path} onLogout={() => setSession({ authed: false })}>
        <Router onChange={(e) => setPath(e.url)}>
          <Dashboard path="/" />
          <BotDetail path="/bots/:name" name="" />
          <Settings path="/settings" />
          <Operator path="/operator" />
          <Docs path="/docs" />
          <Docs path="/docs/:file" />
        </Router>
      </Layout>
    </>
  )
}

render(<App />, document.getElementById('app')!)
