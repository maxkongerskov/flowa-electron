// The node typecheck project does not set jsx, so vitest runs this renderer test on its own.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AcknowledgementsView } from '../src/renderer/src/views/AcknowledgementsView'

describe('AcknowledgementsView', () => {
  it('shows the added third-party names', () => {
    const html = renderToStaticMarkup(createElement(AcknowledgementsView, { onClose: () => undefined }))
    expect(html).toContain('Acknowledgements')
    for (const name of ['cpp-httplib', 'nlohmann/json', 'miniaudio', 'stb_vorbis', 'electron-updater', 'lucide-react', 'sax']) {
      expect(html).toContain(name)
    }
    expect(html).not.toMatch(/license[- ]key/i)
    expect(html).not.toMatch(/\bpricing\b/i)
  })
})
