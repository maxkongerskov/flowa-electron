import { describe, expect, it } from 'vitest'
import { readVersionWhenReady } from '../scripts/real-update-122.mjs'

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

  it('reports the last read when the version never arrives', async () => {
    await expect(readVersionWhenReady(() => '1.2.2', '1.2.3', 30, 5)).rejects.toThrow(/version 1\.2\.2/)
  })
})
