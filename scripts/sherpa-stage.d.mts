export const sherpaOfflineName: string
export const macSherpaResourcePaths: readonly string[]
export const macSherpaDylibs: readonly string[]
export function isSharedLibrary(file: string): boolean
export function isOnnxRuntimeLibrary(file: string): boolean
export function preferRealLibraries(files: string[], isSymlink: (file: string) => boolean): string[]
export function planSherpaStage(files: string[], binaryName: string): { src: string; dest: string }[]
export function siblingSymlink(destName: string, linkText: string, stagedNames: Set<string>): string | null
export function planDarwinRewrite(
  macho: { id?: string | null; loads?: string[]; rpaths?: string[]; basename: string; isDylib: boolean },
  shipped: Iterable<string>
): { changes: { from: string; to: string }[]; id: string | null; addRpath: string | null }
export function parseOtoolLibraries(text: string): string[]
export function parseOtoolId(text: string): string | null
export function parseOtoolRpaths(text: string): string[]
