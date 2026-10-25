import { describe, expect, it } from 'vitest'
import { readVersionWhenReady, versionMatches } from '../scripts/real-update-122.mjs'

describe('NSIS version read', () => {
  it('waits through a torn asar read until the installed version matches', async () => {
    const reads = [
      () => {
        throw new SyntaxError('Unexpected token \'k\', " key, speak"... is not valid JSON')
      },
      () => '1.2.2',
      () => '1.2.3'
    ]
    let index = 0
    await readVersionWhenReady(() => reads[index++](), '1.2.3', 5_000, 1)
    expect(index).toBe(3)
  })

  it('accepts the four-part Windows product version', async () => {
    expect(versionMatches('1.2.3.0', '1.2.3')).toBe(true)
    expect(versionMatches('1.2.30', '1.2.3')).toBe(false)
    expect(versionMatches('1.2.2.0', '1.2.3')).toBe(false)
    let index = 0
    const reads = ['1.2.2.0', '1.2.3.0']
    await readVersionWhenReady(() => reads[index++] ?? '1.2.2.0', '1.2.3', 5_000, 1)
    expect(index).toBe(2)
  })

  it('reports the last read when the version never arrives', async () => {
    await expect(readVersionWhenReady(() => '1.2.2', '1.2.3', 30, 5)).rejects.toThrow(/version 1\.2\.2/)
  })
})
