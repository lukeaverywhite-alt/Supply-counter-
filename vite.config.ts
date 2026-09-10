import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs allow the same build to run at a GitHub Pages
  // repository path (for example /Supply-counter-/) and on a custom domain.
  base: './',
  plugins: [react()],
})
