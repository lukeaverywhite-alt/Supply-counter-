import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createRuntimeController } from './private-sync/runtime'
import { EmbeddedTestnetWallet } from './blockchain/EmbeddedTestnetWallet'
import './styles.css'

const controller = await createRuntimeController()
const walletStatusProvider = new EmbeddedTestnetWallet()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} walletStatusProvider={walletStatusProvider} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
