// What GPU backends this machine can host. The staged binaries decide
// whether Flowa can actually use them; this only answers "is the device there?".

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { vulkanSummaryIsUsable, type GpuProbe } from '@shared/speech'
import { commandExists } from './proc'

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return fallback
}

function nvidiaPresent(platform: string): boolean {
  if (fs.existsSync('/proc/driver/nvidia/version')) return true
  if (platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    if (fs.existsSync(`${pf}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`)) return true
  }
  return commandExists('nvidia-smi')
}

function vulkanLoaderPresent(platform: string): boolean {
  if (platform === 'win32') {
    const root = process.env.WINDIR || 'C:\\Windows'
    return fs.existsSync(`${root}\\System32\\vulkan-1.dll`) || fs.existsSync(`${root}\\Sysnative\\vulkan-1.dll`)
  }
  if (platform === 'linux') {
    const candidates = [
      '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
      '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
      '/usr/lib64/libvulkan.so.1',
      '/usr/lib/libvulkan.so.1'
    ]
    if (candidates.some((p) => fs.existsSync(p))) return true
    return commandExists('vulkaninfo')
  }
  // macOS GPU dictation goes through Metal. Vulkan is an explicit choice.
  return false
}

/** vulkaninfo is optional. A timeout or a missing binary means "unknown", not "no GPU". */
function readVulkanInfoSummary(): string | null {
  const result = spawnSync('vulkaninfo', ['--summary'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (result.error || result.status !== 0) return null
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  return text || null
}

function vulkanPresent(platform: string): boolean {
  if (!vulkanLoaderPresent(platform)) return false
  // A missing vulkaninfo means try Vulkan. CPU devices and named software
  // stacks (lavapipe, llvmpipe, SwiftShader, Basic Render, WARP) stay on CPU.
  return vulkanSummaryIsUsable(readVulkanInfoSummary())
}

export function probeGpu(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): GpuProbe {
  return {
    metal: flag(env, 'FLOWA_GPU_METAL', platform === 'darwin'),
    nvidia: flag(env, 'FLOWA_GPU_NVIDIA', nvidiaPresent(platform)),
    vulkan: flag(env, 'FLOWA_GPU_VULKAN', vulkanPresent(platform))
  }
}
