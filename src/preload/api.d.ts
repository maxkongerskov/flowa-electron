import type { FlowaApi } from './index'
import type { FlowaBarApi } from './bar'

declare global {
  interface Window {
    flowa: FlowaApi
    flowaBar: FlowaBarApi
  }
}
export {}
