// Port of Flowa/Sections/AcknowledgementsView.swift (data-driven licence sheet).
const mitBody = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

const iscBody = `ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

const entries: Array<{ name: string; copyright: string; body: string }> = [
  { name: 'Whisper / OpenAI', copyright: 'Copyright © 2022 OpenAI', body: mitBody },
  { name: 'whisper.cpp / ggml', copyright: 'Copyright © 2023-2026 The ggml authors', body: mitBody },
  { name: 'Electron', copyright: 'Copyright © Electron contributors, Copyright © 2013-2020 GitHub Inc.', body: mitBody },
  { name: 'React', copyright: 'Copyright © Meta Platforms, Inc. and affiliates.', body: mitBody },
  { name: 'Lucide', copyright: 'Copyright © 2026 Lucide Icons and Contributors', body: iscBody }
]

const withCopyright = (body: string, c: string): string => body.replace(/^(MIT License|ISC License)\n\n/, `$1\n\n${c}\n\n`)

export function AcknowledgementsView({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div style={{ display: 'flex', alignItems: 'center', padding: '22px 22px 18px' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Acknowledgements</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>Done</button>
        </div>
        <div className="hairline" />
        <div className="scroll" style={{ flex: 1, padding: 22, display: 'flex', flexDirection: 'column', gap: 16, userSelect: 'text' }}>
          {entries.map((e, i) => (
            <div key={e.name} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {i > 0 && <div className="hairline" />}
              <div style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{withCopyright(e.body, e.copyright)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
