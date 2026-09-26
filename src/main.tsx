import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createRuntimeController } from './private-sync/runtime'
import { EmbeddedTestnetWallet } from './blockchain/EmbeddedTestnetWallet'
import './styles.css'

const controller = await createRuntimeController()
// The embedded wallet is the resolved runtime implementation. Do not replace
// it with the earlier external BRC-100 status-only provider during merges.
const walletStatusProvider = new EmbeddedTestnetWallet()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} walletStatusProvider={walletStatusProvider} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
