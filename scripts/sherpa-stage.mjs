// How sherpa-onnx's shared build is laid out inside Flowa.
//
// sherpa-onnx-offline (macOS and Linux) is linked with
//   @rpath/libonnxruntime.dylib   /   NEEDED libonnxruntime.so
// and an rpath of @loader_path / $ORIGIN, plus a legacy @loader_path/../lib.
// dyld therefore looks for:
//   Contents/Resources/bin/sherpa/libonnxruntime.dylib
//   Contents/Resources/bin/lib/libonnxruntime.dylib   (sherpa/../lib)
// The dylib has to sit beside the binary. A nested sherpa/lib/ folder misses both.
// Signed apps ignore DYLD_LIBRARY_PATH, so the install names have to be @rpath
// and @loader_path has to be on the rpath list.
import path from 'node:path'

export const sherpaOfflineName = 'sherpa-onnx-offline'

/** Files that must exist inside a packaged Flowa.app for Parakeet on macOS. */
export const macSherpaResourcePaths = [
  'Contents/Resources/bin/sherpa/sherpa-onnx-offline',
  'Contents/Resources/bin/sherpa/libonnxruntime.dylib',
  'Contents/Resources/bin/sherpa/libsherpa-onnx-c-api.dylib',
  'Contents/Resources/bin/sherpa/libsherpa-onnx-cxx-api.dylib'
]

/** Shared libraries that ship beside the macOS offline CLI. */
export const macSherpaDylibs = [
  'libonnxruntime.dylib',
  'libsherpa-onnx-c-api.dylib',
  'libsherpa-onnx-cxx-api.dylib'
]

export function isSharedLibrary(file) {
  const base = path.basename(file)
  return base.endsWith('.dylib') || base.endsWith('.dll') || base.includes('.so')
}

export function isOnnxRuntimeLibrary(file) {
  const base = path.basename(file).toLowerCase()
  return base === 'libonnxruntime.dylib'
    || base === 'libonnxruntime.so'
    || base.startsWith('libonnxruntime.so.')
    || base === 'onnxruntime.dll'
    || base === 'libonnxruntime.dll'
}

/**
 * Real files first so a versioned library wins over a same-named symlink.
 * @param {string[]} files
 * @param {(file: string) => boolean} isSymlink
 */
export function preferRealLibraries(files, isSymlink) {
  return [...files].sort((a, b) => Number(isSymlink(a)) - Number(isSymlink(b)))
}

/**
 * Flat copy plan: the offline CLI and every shared library, each named by its
 * basename so they land in the same directory. The first path for a basename wins.
 * @param {string[]} files absolute or archive-relative paths
 * @param {string} binaryName
 * @returns {{ src: string, dest: string }[]}
 */
export function planSherpaStage(files, binaryName) {
  const binary = files.find((f) => path.basename(f) === binaryName)
  const plan = []
  const seen = new Set()
  if (binary) {
    plan.push({ src: binary, dest: binaryName })
    seen.add(binaryName)
  }
  for (const file of files) {
    if (!isSharedLibrary(file)) continue
    const dest = path.basename(file)
    if (seen.has(dest)) continue
    seen.add(dest)
    plan.push({ src: file, dest })
  }
  return plan
}

/**
 * Recreate a symlink only when it points at another staged basename.
 * A self-link (libfoo.so -> libfoo.so) is copied as file bytes instead.
 * @param {string} destName
 * @param {string} linkText
 * @param {Set<string>} stagedNames
 * @returns {string | null}
 */
export function siblingSymlink(destName, linkText, stagedNames) {
  const base = path.basename(linkText)
  if (base && base !== destName && stagedNames.has(base)) return base
  return null
}

/**
 * install_name_tool steps so every shipped dependency is @rpath/<basename>
 * and @loader_path is an rpath. System libraries are left alone.
 * @param {{ id?: string | null, loads?: string[], rpaths?: string[], basename: string, isDylib: boolean }} macho
 * @param {Iterable<string>} shipped
 */
export function planDarwinRewrite(macho, shipped) {
  const names = new Set(shipped)
  const changes = []
  for (const dep of macho.loads || []) {
    const base = path.basename(dep)
    if (!names.has(base)) continue
    const want = `@rpath/${base}`
    if (dep !== want) changes.push({ from: dep, to: want })
  }
  const wantId = `@rpath/${macho.basename}`
  return {
    changes,
    id: macho.isDylib && macho.id !== wantId ? wantId : null,
    addRpath: (macho.rpaths || []).includes('@loader_path') ? null : '@loader_path'
  }
}

/** Names from `otool -L` (the binary's own install id included, when it is a dylib). */
export function parseOtoolLibraries(text) {
  const names = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const match = line.match(/^\s+(.+?)\s+\(compatibility version\s+/)
    if (match) names.push(match[1])
  }
  return names
}

/** Install id from `otool -D`, or null for an executable. */
export function parseOtoolId(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length >= 2 ? lines[1] : null
}

/** LC_RPATH paths from `otool -l`. */
export function parseOtoolRpaths(text) {
  const rpaths = []
  const re = /^\s+path\s+(.+?)\s+\(offset \d+\)$/gm
  for (let match = re.exec(text); match; match = re.exec(text)) rpaths.push(match[1])
  return rpaths
}
