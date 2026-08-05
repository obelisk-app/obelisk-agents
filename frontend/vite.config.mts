import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:3021',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
