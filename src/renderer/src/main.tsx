import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/theme.css'
import './styles/prototype.css'
import './styles/project-design.css'
import './styles/focus.css'
import { App } from './App'

// No StrictMode: its double-invoked effects would attach, kill and re-attach a
// real tmux client on every mount, which the agents see as a resize storm.
createRoot(document.getElementById('root')!).render(<App />)
