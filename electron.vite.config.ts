import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Production builds leave this false, so update-test environment variables do nothing.
const e2eUpdates = process.env.FLOWA_E2E_UPDATES === '1'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@license': resolve('src/license') } },
    define: { __FLOWA_E2E__: JSON.stringify(e2eUpdates) }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@license': resolve('src/license') } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), bar: resolve('src/preload/bar.ts') }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@license': resolve('src/license') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          bar: resolve('src/renderer/bar.html')
        }
      }
    }
  }
})
