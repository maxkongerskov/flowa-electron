// Remember a Vulkan attempt that failed to start or ran past its time budget.
// Automatic mode reads this on the next launch and stays on CPU. Changing
// Hardware deletes the file, a later successful Vulkan start deletes it, and
// a different app version deletes it so the next update can try Vulkan again.

import fs from 'node:fs'
import path from 'node:path'
import {
  encodeVulkanAutoSkip,
  parseVulkanAutoSkip,
  vulkanAutoSkipFile,
  type VulkanSkipReason
} from '@shared/speech'

export function vulkanAutoSkipPath(userData: string): string {
  return path.join(userData, vulkanAutoSkipFile)
}

export function readVulkanAutoSkip(userData: string, appVersion: string): VulkanSkipReason | null {
  let raw: string
  try {
    raw = fs.readFileSync(vulkanAutoSkipPath(userData), 'utf8')
  } catch {
    return null
  }
  const parsed = parseVulkanAutoSkip(raw)
  if (parsed?.version === appVersion) return parsed.reason
  clearVulkanAutoSkip(userData)
  if (parsed) {
    console.log(`[Flowa] Vulkan fallback was for ${parsed.version}; ${appVersion} will try Vulkan again`)
  }
  return null
}

export function writeVulkanAutoSkip(userData: string, reason: VulkanSkipReason, appVersion: string): void {
  try {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(vulkanAutoSkipPath(userData), encodeVulkanAutoSkip(reason, appVersion))
  } catch (error) {
    console.error('[Flowa] could not remember the Vulkan fallback', error instanceof Error ? error.message : error)
  }
}

export function clearVulkanAutoSkip(userData: string): void {
  try {
    fs.rmSync(vulkanAutoSkipPath(userData), { force: true })
  } catch (error) {
    console.error('[Flowa] could not clear the Vulkan fallback', error instanceof Error ? error.message : error)
  }
}
