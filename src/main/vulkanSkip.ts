// Remember a Vulkan attempt that failed to start or ran past its time budget.
// Automatic mode reads this on the next launch and stays on CPU. Changing
// Hardware deletes the file, and a later successful Vulkan start deletes it too.

import fs from 'node:fs'
import path from 'node:path'
import {
  encodeVulkanAutoSkip,
  vulkanAutoSkipFile,
  vulkanAutoSkipReason,
  type VulkanSkipReason
} from '@shared/speech'

export function vulkanAutoSkipPath(userData: string): string {
  return path.join(userData, vulkanAutoSkipFile)
}

export function readVulkanAutoSkip(userData: string): VulkanSkipReason | null {
  try {
    return vulkanAutoSkipReason(fs.readFileSync(vulkanAutoSkipPath(userData), 'utf8'))
  } catch {
    return null
  }
}

export function writeVulkanAutoSkip(userData: string, reason: VulkanSkipReason): void {
  try {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(vulkanAutoSkipPath(userData), encodeVulkanAutoSkip(reason))
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
