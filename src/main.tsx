import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createRuntimeController } from './private-sync/runtime'
import { Brc100TestnetWalletProvider, UnconfiguredTestnetWalletStatusProvider } from './blockchain/ArgusWalletAdapter'
import { resolveBlockchainMode } from './blockchain/config'
import './styles.css'

const controller = await createRuntimeController()
const walletStatusProvider = resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE) === 'testnet'
  ? new Brc100TestnetWalletProvider()
  : new UnconfiguredTestnetWalletStatusProvider()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} walletStatusProvider={walletStatusProvider} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
