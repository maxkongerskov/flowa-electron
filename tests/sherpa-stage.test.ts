import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isOnnxRuntimeLibrary, isSharedLibrary, macSherpaDylibs, macSherpaResourcePaths, parseOtoolId,
  parseOtoolLibraries, parseOtoolRpaths, planDarwinRewrite, planSherpaStage, preferRealLibraries, siblingSymlink
} from '../scripts/sherpa-stage.mjs'

describe('sherpa stage plan', () => {
  const archive = [
    'sherpa-onnx-v1.13.8-osx-arm64-shared/bin/sherpa-onnx-offline',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/bin/sherpa-onnx',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/bin/sherpa-onnx-offline-tts',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/lib/libonnxruntime.dylib',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/lib/libsherpa-onnx-c-api.dylib',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/lib/libsherpa-onnx-cxx-api.dylib',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/include/sherpa-onnx/c-api.h',
    'sherpa-onnx-v1.13.8-osx-arm64-shared/README.md'
  ]

  it('flattens onnxruntime and the sherpa dylibs next to the offline CLI', () => {
    const plan = planSherpaStage(archive, 'sherpa-onnx-offline')
    expect(plan.map((entry) => entry.dest)).toEqual([
      'sherpa-onnx-offline',
      ...macSherpaDylibs
    ])
    expect(plan[0].src).toContain('/bin/sherpa-onnx-offline')
    expect(plan.find((entry) => entry.dest === 'libonnxruntime.dylib')?.src).toContain('/lib/libonnxruntime.dylib')
    expect(plan.some((entry) => entry.dest.includes('sherpa-onnx-offline-tts'))).toBe(false)
    expect(plan.some((entry) => entry.dest.endsWith('.h'))).toBe(false)
  })

  it('keeps Linux and Windows shared libraries beside the binary', () => {
    const plan = planSherpaStage([
      'root/bin/sherpa-onnx-offline',
      'root/lib/libonnxruntime.so',
      'root/lib/libonnxruntime.so.1',
      'root/lib/libsherpa-onnx-c-api.so',
      'root/bin/sherpa-onnx-offline.exe',
      'root/lib/onnxruntime.dll'
    ], 'sherpa-onnx-offline')
    expect(plan.map((entry) => entry.dest)).toEqual([
      'sherpa-onnx-offline',
      'libonnxruntime.so',
      'libonnxruntime.so.1',
      'libsherpa-onnx-c-api.so',
      'onnxruntime.dll'
    ])
  })

  it('prefers a real library over a same-named symlink', () => {
    const ordered = preferRealLibraries(
      ['lib/libonnxruntime.so', 'lib/real/libonnxruntime.so'],
      (file) => file.startsWith('lib/lib')
    )
    expect(planSherpaStage(ordered, 'sherpa-onnx-offline').find((e) => e.dest === 'libonnxruntime.so')?.src)
      .toBe('lib/real/libonnxruntime.so')
  })

  it('recreates a version symlink and refuses a self-link', () => {
    const staged = new Set(['libonnxruntime.so', 'libonnxruntime.so.1'])
    expect(siblingSymlink('libonnxruntime.so', 'libonnxruntime.so.1', staged)).toBe('libonnxruntime.so.1')
    expect(siblingSymlink('libonnxruntime.so', '../lib/libonnxruntime.so', staged)).toBeNull()
  })

  it('documents the Flowa.app resource paths', () => {
    expect([...macSherpaResourcePaths]).toEqual([
      'Contents/Resources/bin/sherpa/sherpa-onnx-offline',
      'Contents/Resources/bin/sherpa/libonnxruntime.dylib',
      'Contents/Resources/bin/sherpa/libsherpa-onnx-c-api.dylib',
      'Contents/Resources/bin/sherpa/libsherpa-onnx-cxx-api.dylib'
    ])
  })
})

describe('darwin install names', () => {
  const shipped = ['sherpa-onnx-offline', ...macSherpaDylibs]

  it('retargets a nested rpath and adds @loader_path', () => {
    const plan = planDarwinRewrite({
      basename: 'sherpa-onnx-offline',
      isDylib: false,
      id: null,
      loads: ['/usr/lib/libSystem.B.dylib', '@rpath/../lib/libonnxruntime.dylib', '/usr/lib/libc++.1.dylib'],
      rpaths: ['@loader_path/../lib']
    }, shipped)
    expect(plan.changes).toEqual([{ from: '@rpath/../lib/libonnxruntime.dylib', to: '@rpath/libonnxruntime.dylib' }])
    expect(plan.id).toBeNull()
    expect(plan.addRpath).toBe('@loader_path')
  })

  it('sets a dylib id and leaves an already-correct binary alone', () => {
    expect(planDarwinRewrite({
      basename: 'libonnxruntime.dylib',
      isDylib: true,
      id: '/usr/local/lib/libonnxruntime.dylib',
      loads: ['/usr/lib/libSystem.B.dylib'],
      rpaths: ['@loader_path']
    }, shipped)).toEqual({
      changes: [],
      id: '@rpath/libonnxruntime.dylib',
      addRpath: null
    })
    expect(planDarwinRewrite({
      basename: 'sherpa-onnx-offline',
      isDylib: false,
      id: null,
      loads: ['/usr/lib/libSystem.B.dylib', '@rpath/libonnxruntime.dylib'],
      rpaths: ['@loader_path', '@loader_path/../lib']
    }, shipped)).toEqual({ changes: [], id: null, addRpath: null })
  })

  it('parses otool load commands', () => {
    expect(parseOtoolLibraries([
      'sherpa-onnx-offline:',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
      '\t@rpath/libonnxruntime.dylib (compatibility version 0.0.0, current version 0.0.0)'
    ].join('\n'))).toEqual(['/usr/lib/libSystem.B.dylib', '@rpath/libonnxruntime.dylib'])
    expect(parseOtoolId('libonnxruntime.dylib:\n\t@rpath/libonnxruntime.dylib\n')).toBe('@rpath/libonnxruntime.dylib')
    expect(parseOtoolId('sherpa-onnx-offline:\n')).toBeNull()
    expect(parseOtoolRpaths([
      'Load command 12',
      '          cmd LC_RPATH',
      '      cmdsize 32',
      '         path @loader_path (offset 12)',
      'Load command 13',
      '          cmd LC_RPATH',
      '      cmdsize 40',
      '         path @loader_path/../lib (offset 12)'
    ].join('\n'))).toEqual(['@loader_path', '@loader_path/../lib'])
  })
})

describe('setup:sherpa and the release config', () => {
  it('stages with the flat plan and still pins the sherpa version', () => {
    const script = fs.readFileSync('scripts/fetch-sherpa.mjs', 'utf8')
    expect(script).toContain("const SHERPA = '1.13.8'")
    expect(script).toContain('planSherpaStage')
    expect(script).toContain('install_name_tool')
    expect(script).not.toContain('fromRoot')
  })

  it('refuses a release whose macOS sherpa tree hid onnxruntime in lib/', () => {
    const release = fs.readFileSync('electron-builder.release.cjs', 'utf8')
    expect(release).toContain('libonnxruntime.dylib')
    expect(release).toContain('libonnxruntime.so')
    expect(release).toContain("@loader_path")
    const sh = fs.readFileSync('scripts/build-release.sh', 'utf8')
    expect(sh).toContain('libonnxruntime.dylib')
    expect(isSharedLibrary('libonnxruntime.dylib')).toBe(true)
    expect(isOnnxRuntimeLibrary('lib/libonnxruntime.so.1.22.0')).toBe(true)
    expect(isOnnxRuntimeLibrary('libsherpa-onnx-c-api.dylib')).toBe(false)
  })
})
