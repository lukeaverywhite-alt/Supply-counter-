import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createRuntimeController } from './private-sync/runtime'
import { createWalletRuntime } from './blockchain/walletRuntime'
import './styles.css'

const controller = await createRuntimeController()
const walletRuntime = createWalletRuntime(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} walletStatusProvider={walletRuntime.wallet} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
