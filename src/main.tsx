import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createRuntimeController } from './private-sync/runtime'
import './styles.css'

const controller = await createRuntimeController()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
