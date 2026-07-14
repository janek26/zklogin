import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/zklogin/' : '/',
  plugins: [react()],
  build: { target: 'esnext', sourcemap: false },
  optimizeDeps: {
    exclude: ['@noir-lang/noirc_abi', '@noir-lang/acvm_js'],
    esbuildOptions: { target: 'esnext' },
  },
  worker: { format: 'es' },
}))
