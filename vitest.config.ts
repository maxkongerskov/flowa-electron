import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// A shebang is a syntax error once Vite transforms an imported script.
// Windows CI hits that; stripping it first keeps `npm test` portable.
const stripScriptShebang = {
  name: 'strip-script-shebang',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const script = id.includes('/scripts/') || id.includes('\\scripts\\')
    if (script && code.startsWith('#!')) return code.replace(/^#![^\n]*\n?/, '')
    return null
  }
}

export default defineConfig({
  plugins: [stripScriptShebang],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
