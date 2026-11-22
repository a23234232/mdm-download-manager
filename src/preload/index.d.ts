import type { MdmApi } from '@shared/types'

declare global {
  interface Window {
    mdm: MdmApi
  }
}

export {}
