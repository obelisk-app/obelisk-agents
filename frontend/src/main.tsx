import '@nostr-wot/ui/styles.css'
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import Router from 'preact-router'
import { NostrSessionProvider } from '@nostr-wot/ui'
import './style.css'
import { api, Session } from './api'
import { Login } from './components/Login'
import { Layout } from './components/Layout'
import { Toasts } from './components/toast'
import { Dashboard } from './components/Dashboard'
import { BotDetail } from './components/BotDetail'
import { Settings } from './components/Settings'
import { Operator } from './components/Operator'
import { Docs } from './components/Docs'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  // true after an explicit logout: the login screen then waits for a
  // deliberate signer choice instead of silently signing back in.
  const [loggedOut, setLoggedOut] = useState(false)
  const [path, setPath] = useState(window.location.pathname)

  const check = () => api.session().then(setSession).catch(() => setSession({ authed: false }))
  useEffect(() => { check() }, [])

  if (session === null) {
    return (
      <div class="min-h-screen flex items-center justify-center lc-grid-bg">
        <span class="lc-spinner" />
      </div>
    )
  }

  if (!session.authed) return <Login onLogin={check} fresh={loggedOut} />

  return (
    <>
      <Toasts />
      <Layout
        session={session}
        path={path}
        onLogout={() => { setLoggedOut(true); setSession({ authed: false }) }}
      >
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

render(
  <NostrSessionProvider theme="la-crypta" autoRestore>
    <App />
  </NostrSessionProvider>,
  document.getElementById('app')!,
)
